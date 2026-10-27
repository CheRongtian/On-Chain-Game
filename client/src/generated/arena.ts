// Generated from the compiled Arena artifact by the startup scripts.
import type { Abi } from 'viem';

export const arenaAbi = [
  {
    "type": "constructor",
    "inputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "advanceExpiredPhase",
    "inputs": [
      {
        "name": "matchId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "round",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "expectedPhase",
        "type": "uint8",
        "internalType": "enum GameTypes.Phase"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "cancelWaitingMatch",
    "inputs": [
      {
        "name": "matchId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "commitActions",
    "inputs": [
      {
        "name": "matchId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "round",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "commitment",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "createMatch",
    "inputs": [
      {
        "name": "mapId",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "outputs": [
      {
        "name": "matchId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "expireWaitingMatch",
    "inputs": [
      {
        "name": "matchId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "getBattleState",
    "inputs": [
      {
        "name": "matchId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct GameTypes.BattleState",
        "components": [
          {
            "name": "mapId",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "round",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "players",
            "type": "tuple[2]",
            "internalType": "struct GameTypes.PlayerState[2]",
            "components": [
              {
                "name": "energy",
                "type": "uint8",
                "internalType": "uint8"
              },
              {
                "name": "victoryPoints",
                "type": "uint8",
                "internalType": "uint8"
              }
            ]
          },
          {
            "name": "units",
            "type": "tuple[6]",
            "internalType": "struct GameTypes.UnitState[6]",
            "components": [
              {
                "name": "unitType",
                "type": "uint8",
                "internalType": "enum GameTypes.UnitKind"
              },
              {
                "name": "cell",
                "type": "uint8",
                "internalType": "uint8"
              },
              {
                "name": "hp",
                "type": "uint8",
                "internalType": "uint8"
              }
            ]
          },
          {
            "name": "outcome",
            "type": "uint8",
            "internalType": "enum GameTypes.Outcome"
          },
          {
            "name": "reason",
            "type": "uint8",
            "internalType": "enum GameTypes.EndReason"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getMap",
    "inputs": [
      {
        "name": "mapId",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct GameTypes.MapConfig",
        "components": [
          {
            "name": "mapId",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "width",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "height",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "obstacles",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "resources",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "controlZone",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "spawnsA",
            "type": "uint8[3]",
            "internalType": "uint8[3]"
          },
          {
            "name": "spawnsB",
            "type": "uint8[3]",
            "internalType": "uint8[3]"
          }
        ]
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "getMatch",
    "inputs": [
      {
        "name": "matchId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct GameTypes.MatchSummary",
        "components": [
          {
            "name": "players",
            "type": "address[2]",
            "internalType": "address[2]"
          },
          {
            "name": "mapId",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "rulesHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "phase",
            "type": "uint8",
            "internalType": "enum GameTypes.Phase"
          },
          {
            "name": "round",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "joinDeadline",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "phaseDeadline",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "stateHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "outcome",
            "type": "uint8",
            "internalType": "enum GameTypes.Outcome"
          },
          {
            "name": "reason",
            "type": "uint8",
            "internalType": "enum GameTypes.EndReason"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getRoundStatus",
    "inputs": [
      {
        "name": "matchId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct GameTypes.RoundStatus",
        "components": [
          {
            "name": "commitments",
            "type": "bytes32[2]",
            "internalType": "bytes32[2]"
          },
          {
            "name": "committed",
            "type": "bool[2]",
            "internalType": "bool[2]"
          },
          {
            "name": "revealed",
            "type": "bool[2]",
            "internalType": "bool[2]"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getRules",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct GameTypes.Rules",
        "components": [
          {
            "name": "initialEnergy",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "maxEnergy",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "maxRounds",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "victoryThreshold",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "resourceIncome",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "controlAward",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "phaseDuration",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "roomLifetime",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "maxHp",
            "type": "uint8[3]",
            "internalType": "uint8[3]"
          },
          {
            "name": "moveRange",
            "type": "uint8[3]",
            "internalType": "uint8[3]"
          },
          {
            "name": "attackRange",
            "type": "uint8[3]",
            "internalType": "uint8[3]"
          },
          {
            "name": "attackDamage",
            "type": "uint8[3]",
            "internalType": "uint8[3]"
          },
          {
            "name": "skillCost",
            "type": "uint8[3]",
            "internalType": "uint8[3]"
          },
          {
            "name": "shieldReduction",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "powerShotDamage",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "dashRange",
            "type": "uint8",
            "internalType": "uint8"
          }
        ]
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "getRulesHash",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "joinMatch",
    "inputs": [
      {
        "name": "matchId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "revealActions",
    "inputs": [
      {
        "name": "matchId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "round",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "actions",
        "type": "tuple[3]",
        "internalType": "struct GameTypes.Action[3]",
        "components": [
          {
            "name": "kind",
            "type": "uint8",
            "internalType": "enum GameTypes.ActionKind"
          },
          {
            "name": "targetCell",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "pathLength",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "path",
            "type": "uint8[4]",
            "internalType": "uint8[4]"
          }
        ]
      },
      {
        "name": "salt",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "settleRound",
    "inputs": [
      {
        "name": "matchId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "round",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "startMatch",
    "inputs": [
      {
        "name": "matchId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "event",
    "name": "ActionCommitted",
    "inputs": [
      {
        "name": "matchId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "round",
        "type": "uint8",
        "indexed": true,
        "internalType": "uint8"
      },
      {
        "name": "player",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "commitment",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ActionRevealed",
    "inputs": [
      {
        "name": "matchId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "round",
        "type": "uint8",
        "indexed": true,
        "internalType": "uint8"
      },
      {
        "name": "player",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "actions",
        "type": "tuple[3]",
        "indexed": false,
        "internalType": "struct GameTypes.Action[3]",
        "components": [
          {
            "name": "kind",
            "type": "uint8",
            "internalType": "enum GameTypes.ActionKind"
          },
          {
            "name": "targetCell",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "pathLength",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "path",
            "type": "uint8[4]",
            "internalType": "uint8[4]"
          }
        ]
      },
      {
        "name": "salt",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "MatchCreated",
    "inputs": [
      {
        "name": "matchId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "creator",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "mapId",
        "type": "uint8",
        "indexed": false,
        "internalType": "uint8"
      },
      {
        "name": "rulesHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "joinDeadline",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "MatchFinished",
    "inputs": [
      {
        "name": "matchId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "round",
        "type": "uint8",
        "indexed": false,
        "internalType": "uint8"
      },
      {
        "name": "winner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "outcome",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum GameTypes.Outcome"
      },
      {
        "name": "reason",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum GameTypes.EndReason"
      },
      {
        "name": "stateHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "MatchStarted",
    "inputs": [
      {
        "name": "matchId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "initialState",
        "type": "tuple",
        "indexed": false,
        "internalType": "struct GameTypes.BattleState",
        "components": [
          {
            "name": "mapId",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "round",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "players",
            "type": "tuple[2]",
            "internalType": "struct GameTypes.PlayerState[2]",
            "components": [
              {
                "name": "energy",
                "type": "uint8",
                "internalType": "uint8"
              },
              {
                "name": "victoryPoints",
                "type": "uint8",
                "internalType": "uint8"
              }
            ]
          },
          {
            "name": "units",
            "type": "tuple[6]",
            "internalType": "struct GameTypes.UnitState[6]",
            "components": [
              {
                "name": "unitType",
                "type": "uint8",
                "internalType": "enum GameTypes.UnitKind"
              },
              {
                "name": "cell",
                "type": "uint8",
                "internalType": "uint8"
              },
              {
                "name": "hp",
                "type": "uint8",
                "internalType": "uint8"
              }
            ]
          },
          {
            "name": "outcome",
            "type": "uint8",
            "internalType": "enum GameTypes.Outcome"
          },
          {
            "name": "reason",
            "type": "uint8",
            "internalType": "enum GameTypes.EndReason"
          }
        ]
      },
      {
        "name": "stateHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PhaseAdvanced",
    "inputs": [
      {
        "name": "matchId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "round",
        "type": "uint8",
        "indexed": true,
        "internalType": "uint8"
      },
      {
        "name": "phase",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum GameTypes.Phase"
      },
      {
        "name": "deadline",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PlayerJoined",
    "inputs": [
      {
        "name": "matchId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "player",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RoundResolved",
    "inputs": [
      {
        "name": "matchId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "round",
        "type": "uint8",
        "indexed": true,
        "internalType": "uint8"
      },
      {
        "name": "beforeStateHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "afterStateHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "players",
        "type": "tuple[2]",
        "indexed": false,
        "internalType": "struct GameTypes.PlayerState[2]",
        "components": [
          {
            "name": "energy",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "victoryPoints",
            "type": "uint8",
            "internalType": "uint8"
          }
        ]
      },
      {
        "name": "outcome",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum GameTypes.Outcome"
      },
      {
        "name": "reason",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum GameTypes.EndReason"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "AlreadyCommitted",
    "inputs": [
      {
        "name": "player",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "AlreadyRevealed",
    "inputs": [
      {
        "name": "player",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "BattleNotStarted",
    "inputs": [
      {
        "name": "matchId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "CommitmentMismatch",
    "inputs": []
  },
  {
    "type": "error",
    "name": "DeadlineNotPassed",
    "inputs": [
      {
        "name": "deadline",
        "type": "uint64",
        "internalType": "uint64"
      }
    ]
  },
  {
    "type": "error",
    "name": "DeadlinePassed",
    "inputs": [
      {
        "name": "deadline",
        "type": "uint64",
        "internalType": "uint64"
      }
    ]
  },
  {
    "type": "error",
    "name": "InsufficientEnergy",
    "inputs": [
      {
        "name": "playerIndex",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "required",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "available",
        "type": "uint8",
        "internalType": "uint8"
      }
    ]
  },
  {
    "type": "error",
    "name": "InvalidAction",
    "inputs": [
      {
        "name": "unitId",
        "type": "uint8",
        "internalType": "uint8"
      }
    ]
  },
  {
    "type": "error",
    "name": "InvalidActionEncoding",
    "inputs": [
      {
        "name": "slot",
        "type": "uint8",
        "internalType": "uint8"
      }
    ]
  },
  {
    "type": "error",
    "name": "InvalidBattleResult",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidCell",
    "inputs": [
      {
        "name": "cell",
        "type": "uint8",
        "internalType": "uint8"
      }
    ]
  },
  {
    "type": "error",
    "name": "InvalidCoordinates",
    "inputs": [
      {
        "name": "x",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "y",
        "type": "uint8",
        "internalType": "uint8"
      }
    ]
  },
  {
    "type": "error",
    "name": "InvalidPath",
    "inputs": [
      {
        "name": "unitId",
        "type": "uint8",
        "internalType": "uint8"
      }
    ]
  },
  {
    "type": "error",
    "name": "InvalidPhase",
    "inputs": [
      {
        "name": "expected",
        "type": "uint8",
        "internalType": "enum GameTypes.Phase"
      },
      {
        "name": "actual",
        "type": "uint8",
        "internalType": "enum GameTypes.Phase"
      }
    ]
  },
  {
    "type": "error",
    "name": "InvalidPlayerState",
    "inputs": [
      {
        "name": "playerIndex",
        "type": "uint8",
        "internalType": "uint8"
      }
    ]
  },
  {
    "type": "error",
    "name": "InvalidRound",
    "inputs": [
      {
        "name": "round",
        "type": "uint8",
        "internalType": "uint8"
      }
    ]
  },
  {
    "type": "error",
    "name": "InvalidTarget",
    "inputs": [
      {
        "name": "unitId",
        "type": "uint8",
        "internalType": "uint8"
      }
    ]
  },
  {
    "type": "error",
    "name": "InvalidTimeoutPhase",
    "inputs": [
      {
        "name": "phase",
        "type": "uint8",
        "internalType": "enum GameTypes.Phase"
      }
    ]
  },
  {
    "type": "error",
    "name": "InvalidUnitState",
    "inputs": [
      {
        "name": "unitId",
        "type": "uint8",
        "internalType": "uint8"
      }
    ]
  },
  {
    "type": "error",
    "name": "NotCreator",
    "inputs": [
      {
        "name": "caller",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "NotPlayer",
    "inputs": [
      {
        "name": "caller",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "OpponentMissing",
    "inputs": []
  },
  {
    "type": "error",
    "name": "RoomFull",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SelfJoin",
    "inputs": []
  },
  {
    "type": "error",
    "name": "StaleRound",
    "inputs": [
      {
        "name": "expected",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "actual",
        "type": "uint8",
        "internalType": "uint8"
      }
    ]
  },
  {
    "type": "error",
    "name": "UnknownMap",
    "inputs": [
      {
        "name": "mapId",
        "type": "uint8",
        "internalType": "uint8"
      }
    ]
  },
  {
    "type": "error",
    "name": "UnknownMatch",
    "inputs": [
      {
        "name": "matchId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  }
] as const satisfies Abi;
