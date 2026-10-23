# Contract Project

Foundry and Solidity build settings are configured. src/BuildInfo.sol is a real compiler input for checking the pinned compiler; it contains no Arena state, external game write methods, or deployment workflow.

Run forge fmt --check here for formatting. On the current machine, Solidity 0.8.30 is available locally, and the following build has succeeded:

```
forge build --use ../.local/bin/solc-0.8.30 --offline
```

The build command uses a locally installed compiler. Plain forge build uses Forge-managed compilers and may try to download the pinned version.

Gameplay rules are specified for the fixed Guardian/Ranger/Scout squad. Action encoding, hashes, event fields, and public ABI must be finalized before the Arena contract is implemented. There are no external Solidity dependencies or test libraries yet.
