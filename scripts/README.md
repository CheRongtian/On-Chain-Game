# Project Scripts

Daily startup uses two scripts, run in separate terminals from the project root:

```
./scripts/run-frontend.sh
```

```
./scripts/run-backend.sh
```

The frontend script locates the project and starts Vite in client/. Its output remains in that terminal.

The backend script locates the project, truncates a local log in the project root, validates [the map configuration](../specs/v1/map.json) with the standard-library Go map utility, and then starts the Go application. All subsequent standard output and error output, including compilation errors, goes to that log. A failed map check prevents application startup. The current application prints a development notice and exits.

Both scripts can be invoked through their absolute paths from another working directory. Install dependencies before first use; the scripts do not install tools or packages. Future required backend components must use the same backend startup entry, keeping daily startup to these two scripts.

ABI export and deployment tooling will be introduced with the contract implementation. These launchers currently run only the development entries and map validation.
