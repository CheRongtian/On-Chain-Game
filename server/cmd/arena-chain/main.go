package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"onchainarena/server/internal/localchain"
)

func main() {
	if err := run(); err != nil {
		log.Print("Local archive chain: ", err)
		os.Exit(1)
	}
}

func run() (err error) {
	if len(os.Args) != 3 {
		return fmt.Errorf("expected the project root and a loopback RPC port")
	}
	root, err := filepath.Abs(os.Args[1])
	if err != nil {
		return err
	}
	listener, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", os.Args[2]))
	if err != nil {
		return err
	}
	defer listener.Close()
	chain, err := localchain.Open(root)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, chain.Close()) }()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	server := &http.Server{Handler: chain, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second,
		WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second}
	ready, err := json.Marshal(map[string]any{"rpcUrl": "http://" + listener.Addr().String(), "chainId": 31337, "engine": "geth"})
	if err != nil {
		return err
	}
	log.Printf("Geth archive chain ready: %s. Blocks are produced for transactions and expired-phase clock updates.", ready)
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	select {
	case <-ctx.Done():
	case err = <-done:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	return server.Shutdown(shutdown)
}
