package indexer

import (
	"database/sql"
	"errors"
	"log"
	"net/http"
	"strconv"
	"time"
)

func (s *service) replayRoute(view string) http.HandlerFunc {
	return s.readFor(30*time.Second, func(r *http.Request, tx *sql.Tx, meta metadata) (any, *apiError) {
		id, failure := matchID(r)
		if failure != nil {
			return nil, failure
		}
		limit, offset, failure := pagination(r)
		if failure != nil {
			return nil, failure
		}
		round := 0
		if text := r.URL.Query().Get("round"); text != "" {
			var err error
			round, err = strconv.Atoi(text)
			if err != nil || round < 1 || round > 20 {
				return nil, &apiError{400, "invalid_round", "Use a round from 1 to 20."}
			}
		}
		result, err := s.replay(r.Context(), tx, id, meta)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, &apiError{404, "match_not_found", "Match has not been indexed in this deployment."}
		}
		if err != nil {
			log.Printf("Read %s for match %s: %v", view, id, err)
			return nil, &apiError{503, "query_failed", "Could not read the indexed history needed for verification."}
		}
		if !result.Verification.Canonical && meta.Error == "" {
			meta.Ready, meta.Error = false, result.Verification.Message
		}
		response := map[string]any{"meta": meta, "matchId": id, "verification": result.Verification,
			"confirmation": meta.confirmation(uint64(max(meta.IndexedBlock, 0)))}
		if view == "verification" {
			return response, nil
		}
		items := []replayFrame{}
		for _, frame := range result.Frames {
			if round == 0 || frame.Round == uint8(round) {
				items = append(items, frame)
			}
		}
		start := min(offset, len(items))
		end := min(start+limit, len(items))
		response["items"] = items[start:end]
		response["limit"], response["offset"], response["hasMore"] = limit, offset, end < len(items)
		if view == "replay" {
			response["rounds"] = result.Rounds
		}
		return response, nil
	})
}
