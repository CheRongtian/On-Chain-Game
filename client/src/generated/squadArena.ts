// Generated from the frozen ISquadArena compiler ABI.
export const squadArenaAbi = [
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'uint256',
        name: 'matchId',
        type: 'uint256',
      },
      {
        indexed: true,
        internalType: 'uint16',
        name: 'round',
        type: 'uint16',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'player',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'bytes32',
        name: 'commitment',
        type: 'bytes32',
      },
    ],
    name: 'ActionCommitted',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'uint256',
        name: 'matchId',
        type: 'uint256',
      },
      {
        indexed: true,
        internalType: 'uint16',
        name: 'round',
        type: 'uint16',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'player',
        type: 'address',
      },
      {
        components: [
          {
            internalType: 'uint8',
            name: 'actionType',
            type: 'uint8',
          },
          {
            internalType: 'uint8',
            name: 'targetCell',
            type: 'uint8',
          },
          {
            internalType: 'uint8',
            name: 'targetUnit',
            type: 'uint8',
          },
          {
            internalType: 'uint8',
            name: 'pathLength',
            type: 'uint8',
          },
          {
            internalType: 'uint32',
            name: 'pathBits',
            type: 'uint32',
          },
        ],
        indexed: false,
        internalType: 'struct SquadCodec.Action[3]',
        name: 'actions',
        type: 'tuple[3]',
      },
      {
        indexed: false,
        internalType: 'bytes32',
        name: 'salt',
        type: 'bytes32',
      },
    ],
    name: 'ActionRevealed',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'uint256',
        name: 'matchId',
        type: 'uint256',
      },
      {
        components: [
          {
            internalType: 'uint8',
            name: 'mapId',
            type: 'uint8',
          },
          {
            internalType: 'bool',
            name: 'battleStarted',
            type: 'bool',
          },
          {
            internalType: 'uint16',
            name: 'completedRound',
            type: 'uint16',
          },
          {
            components: [
              {
                internalType: 'uint8',
                name: 'unitType',
                type: 'uint8',
              },
              {
                internalType: 'uint8',
                name: 'position',
                type: 'uint8',
              },
              {
                internalType: 'uint8',
                name: 'hp',
                type: 'uint8',
              },
              {
                internalType: 'bool',
                name: 'alive',
                type: 'bool',
              },
              {
                internalType: 'uint16',
                name: 'lockedRound',
                type: 'uint16',
              },
            ],
            internalType: 'struct SquadCodec.Unit[6]',
            name: 'units',
            type: 'tuple[6]',
          },
          {
            internalType: 'uint8[2]',
            name: 'energy',
            type: 'uint8[2]',
          },
          {
            internalType: 'uint8[2]',
            name: 'victoryPoints',
            type: 'uint8[2]',
          },
          {
            internalType: 'uint8',
            name: 'outcome',
            type: 'uint8',
          },
          {
            internalType: 'uint8',
            name: 'reason',
            type: 'uint8',
          },
        ],
        indexed: false,
        internalType: 'struct SquadCodec.State',
        name: 'initialState',
        type: 'tuple',
      },
      {
        indexed: false,
        internalType: 'bytes32',
        name: 'stateHash',
        type: 'bytes32',
      },
    ],
    name: 'GameStarted',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'uint256',
        name: 'matchId',
        type: 'uint256',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'creator',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'bytes32',
        name: 'rulesetId',
        type: 'bytes32',
      },
      {
        indexed: false,
        internalType: 'uint8',
        name: 'mapId',
        type: 'uint8',
      },
      {
        indexed: false,
        internalType: 'bytes32',
        name: 'mapHash',
        type: 'bytes32',
      },
      {
        indexed: false,
        internalType: 'uint64',
        name: 'joinDeadline',
        type: 'uint64',
      },
    ],
    name: 'MatchCreated',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'uint256',
        name: 'matchId',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'uint16',
        name: 'round',
        type: 'uint16',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'winner',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'bool',
        name: 'battleStarted',
        type: 'bool',
      },
      {
        indexed: false,
        internalType: 'uint16',
        name: 'completedRound',
        type: 'uint16',
      },
      {
        indexed: false,
        internalType: 'uint8',
        name: 'outcome',
        type: 'uint8',
      },
      {
        indexed: false,
        internalType: 'uint8',
        name: 'reason',
        type: 'uint8',
      },
      {
        indexed: false,
        internalType: 'bytes32',
        name: 'stateHash',
        type: 'bytes32',
      },
    ],
    name: 'MatchFinished',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'uint256',
        name: 'matchId',
        type: 'uint256',
      },
      {
        indexed: true,
        internalType: 'uint16',
        name: 'round',
        type: 'uint16',
      },
      {
        indexed: false,
        internalType: 'uint8',
        name: 'fromPhase',
        type: 'uint8',
      },
      {
        indexed: false,
        internalType: 'uint8',
        name: 'toPhase',
        type: 'uint8',
      },
      {
        indexed: false,
        internalType: 'uint64',
        name: 'deadline',
        type: 'uint64',
      },
    ],
    name: 'PhaseAdvanced',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'uint256',
        name: 'matchId',
        type: 'uint256',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'player',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'uint8',
        name: 'phase',
        type: 'uint8',
      },
      {
        indexed: false,
        internalType: 'uint64',
        name: 'joinDeadline',
        type: 'uint64',
      },
    ],
    name: 'PlayerJoined',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'uint256',
        name: 'matchId',
        type: 'uint256',
      },
      {
        indexed: true,
        internalType: 'uint16',
        name: 'round',
        type: 'uint16',
      },
      {
        indexed: false,
        internalType: 'bytes32',
        name: 'beforeStateHash',
        type: 'bytes32',
      },
      {
        indexed: false,
        internalType: 'bytes32',
        name: 'afterStateHash',
        type: 'bytes32',
      },
      {
        components: [
          {
            internalType: 'uint8',
            name: 'mapId',
            type: 'uint8',
          },
          {
            internalType: 'bool',
            name: 'battleStarted',
            type: 'bool',
          },
          {
            internalType: 'uint16',
            name: 'completedRound',
            type: 'uint16',
          },
          {
            components: [
              {
                internalType: 'uint8',
                name: 'unitType',
                type: 'uint8',
              },
              {
                internalType: 'uint8',
                name: 'position',
                type: 'uint8',
              },
              {
                internalType: 'uint8',
                name: 'hp',
                type: 'uint8',
              },
              {
                internalType: 'bool',
                name: 'alive',
                type: 'bool',
              },
              {
                internalType: 'uint16',
                name: 'lockedRound',
                type: 'uint16',
              },
            ],
            internalType: 'struct SquadCodec.Unit[6]',
            name: 'units',
            type: 'tuple[6]',
          },
          {
            internalType: 'uint8[2]',
            name: 'energy',
            type: 'uint8[2]',
          },
          {
            internalType: 'uint8[2]',
            name: 'victoryPoints',
            type: 'uint8[2]',
          },
          {
            internalType: 'uint8',
            name: 'outcome',
            type: 'uint8',
          },
          {
            internalType: 'uint8',
            name: 'reason',
            type: 'uint8',
          },
        ],
        indexed: false,
        internalType: 'struct SquadCodec.State',
        name: 'state',
        type: 'tuple',
      },
      {
        components: [
          {
            internalType: 'uint8[2]',
            name: 'energySpent',
            type: 'uint8[2]',
          },
          {
            internalType: 'bool[6]',
            name: 'moved',
            type: 'bool[6]',
          },
          {
            internalType: 'uint8[6]',
            name: 'healed',
            type: 'uint8[6]',
          },
          {
            internalType: 'uint8[6]',
            name: 'coverReduced',
            type: 'uint8[6]',
          },
          {
            internalType: 'uint8[6]',
            name: 'shieldReduced',
            type: 'uint8[6]',
          },
          {
            internalType: 'uint8[6]',
            name: 'damageTaken',
            type: 'uint8[6]',
          },
          {
            internalType: 'uint16[6]',
            name: 'lockedRoundApplied',
            type: 'uint16[6]',
          },
          {
            internalType: 'uint8[2]',
            name: 'energyGained',
            type: 'uint8[2]',
          },
          {
            internalType: 'uint8[2]',
            name: 'victoryPointsGained',
            type: 'uint8[2]',
          },
        ],
        indexed: false,
        internalType: 'struct SquadCodec.Effects',
        name: 'effects',
        type: 'tuple',
      },
    ],
    name: 'RoundResolved',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'uint256',
        name: 'matchId',
        type: 'uint256',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'player',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'bytes32',
        name: 'commitment',
        type: 'bytes32',
      },
    ],
    name: 'SquadCommitted',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'uint256',
        name: 'matchId',
        type: 'uint256',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'player',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'uint8[3]',
        name: 'unitTypes',
        type: 'uint8[3]',
      },
      {
        indexed: false,
        internalType: 'bytes32',
        name: 'salt',
        type: 'bytes32',
      },
    ],
    name: 'SquadRevealed',
    type: 'event',
  },
  {
    inputs: [
      {
        internalType: 'uint256',
        name: 'matchId',
        type: 'uint256',
      },
      {
        internalType: 'uint16',
        name: 'round',
        type: 'uint16',
      },
      {
        internalType: 'uint8',
        name: 'expectedPhase',
        type: 'uint8',
      },
    ],
    name: 'advanceExpiredPhase',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'uint256',
        name: 'matchId',
        type: 'uint256',
      },
    ],
    name: 'cancelWaitingMatch',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'uint256',
        name: 'matchId',
        type: 'uint256',
      },
      {
        internalType: 'uint16',
        name: 'round',
        type: 'uint16',
      },
      {
        internalType: 'bytes32',
        name: 'commitment',
        type: 'bytes32',
      },
    ],
    name: 'commitActions',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'uint256',
        name: 'matchId',
        type: 'uint256',
      },
      {
        internalType: 'bytes32',
        name: 'commitment',
        type: 'bytes32',
      },
    ],
    name: 'commitSquad',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'uint8',
        name: 'mapId',
        type: 'uint8',
      },
    ],
    name: 'createMatch',
    outputs: [
      {
        internalType: 'uint256',
        name: 'matchId',
        type: 'uint256',
      },
    ],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'uint256',
        name: 'matchId',
        type: 'uint256',
      },
    ],
    name: 'expireWaitingMatch',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'uint256',
        name: 'matchId',
        type: 'uint256',
      },
    ],
    name: 'getBattleState',
    outputs: [
      {
        components: [
          {
            internalType: 'uint8',
            name: 'mapId',
            type: 'uint8',
          },
          {
            internalType: 'bool',
            name: 'battleStarted',
            type: 'bool',
          },
          {
            internalType: 'uint16',
            name: 'completedRound',
            type: 'uint16',
          },
          {
            components: [
              {
                internalType: 'uint8',
                name: 'unitType',
                type: 'uint8',
              },
              {
                internalType: 'uint8',
                name: 'position',
                type: 'uint8',
              },
              {
                internalType: 'uint8',
                name: 'hp',
                type: 'uint8',
              },
              {
                internalType: 'bool',
                name: 'alive',
                type: 'bool',
              },
              {
                internalType: 'uint16',
                name: 'lockedRound',
                type: 'uint16',
              },
            ],
            internalType: 'struct SquadCodec.Unit[6]',
            name: 'units',
            type: 'tuple[6]',
          },
          {
            internalType: 'uint8[2]',
            name: 'energy',
            type: 'uint8[2]',
          },
          {
            internalType: 'uint8[2]',
            name: 'victoryPoints',
            type: 'uint8[2]',
          },
          {
            internalType: 'uint8',
            name: 'outcome',
            type: 'uint8',
          },
          {
            internalType: 'uint8',
            name: 'reason',
            type: 'uint8',
          },
        ],
        internalType: 'struct SquadCodec.State',
        name: '',
        type: 'tuple',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'uint8',
        name: 'mapId',
        type: 'uint8',
      },
    ],
    name: 'getMap',
    outputs: [
      {
        components: [
          {
            internalType: 'uint8',
            name: 'mapId',
            type: 'uint8',
          },
          {
            internalType: 'uint8',
            name: 'width',
            type: 'uint8',
          },
          {
            internalType: 'uint8',
            name: 'height',
            type: 'uint8',
          },
          {
            internalType: 'uint64',
            name: 'obstacles',
            type: 'uint64',
          },
          {
            internalType: 'uint64',
            name: 'cover',
            type: 'uint64',
          },
          {
            internalType: 'uint64',
            name: 'resources',
            type: 'uint64',
          },
          {
            internalType: 'uint64',
            name: 'controlZone',
            type: 'uint64',
          },
          {
            internalType: 'uint8[3]',
            name: 'spawnsA',
            type: 'uint8[3]',
          },
          {
            internalType: 'uint8[3]',
            name: 'spawnsB',
            type: 'uint8[3]',
          },
          {
            internalType: 'bytes32',
            name: 'mapHash',
            type: 'bytes32',
          },
        ],
        internalType: 'struct SquadCodec.Map',
        name: '',
        type: 'tuple',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'uint256',
        name: 'matchId',
        type: 'uint256',
      },
    ],
    name: 'getMatch',
    outputs: [
      {
        components: [
          {
            internalType: 'address[2]',
            name: 'players',
            type: 'address[2]',
          },
          {
            internalType: 'uint8',
            name: 'mapId',
            type: 'uint8',
          },
          {
            internalType: 'bytes32',
            name: 'mapHash',
            type: 'bytes32',
          },
          {
            internalType: 'bytes32',
            name: 'rulesetId',
            type: 'bytes32',
          },
          {
            internalType: 'uint8',
            name: 'phase',
            type: 'uint8',
          },
          {
            internalType: 'uint16',
            name: 'activeRound',
            type: 'uint16',
          },
          {
            internalType: 'uint64',
            name: 'joinDeadline',
            type: 'uint64',
          },
          {
            internalType: 'uint64',
            name: 'phaseDeadline',
            type: 'uint64',
          },
          {
            internalType: 'bytes32',
            name: 'stateHash',
            type: 'bytes32',
          },
          {
            internalType: 'uint8',
            name: 'outcome',
            type: 'uint8',
          },
          {
            internalType: 'uint8',
            name: 'reason',
            type: 'uint8',
          },
        ],
        internalType: 'struct SquadCodec.MatchSummary',
        name: '',
        type: 'tuple',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'uint256',
        name: 'matchId',
        type: 'uint256',
      },
    ],
    name: 'getRoundStatus',
    outputs: [
      {
        components: [
          {
            internalType: 'bytes32[2]',
            name: 'commitments',
            type: 'bytes32[2]',
          },
          {
            internalType: 'bool[2]',
            name: 'committed',
            type: 'bool[2]',
          },
          {
            internalType: 'bool[2]',
            name: 'revealed',
            type: 'bool[2]',
          },
        ],
        internalType: 'struct SquadCodec.RoundStatus',
        name: '',
        type: 'tuple',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getRules',
    outputs: [
      {
        components: [
          {
            internalType: 'bytes32',
            name: 'semanticsId',
            type: 'bytes32',
          },
          {
            internalType: 'uint8[8]',
            name: 'matchRules',
            type: 'uint8[8]',
          },
          {
            internalType: 'uint8[5][5]',
            name: 'unitRules',
            type: 'uint8[5][5]',
          },
          {
            internalType: 'uint8[10]',
            name: 'skillRules',
            type: 'uint8[10]',
          },
          {
            internalType: 'uint32[5]',
            name: 'windows',
            type: 'uint32[5]',
          },
          {
            internalType: 'uint16[3]',
            name: 'schemas',
            type: 'uint16[3]',
          },
          {
            internalType: 'bytes32[3]',
            name: 'mapHashes',
            type: 'bytes32[3]',
          },
        ],
        internalType: 'struct SquadCodec.Rules',
        name: '',
        type: 'tuple',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getRulesetId',
    outputs: [
      {
        internalType: 'bytes32',
        name: '',
        type: 'bytes32',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getSchemaVersions',
    outputs: [
      {
        internalType: 'uint16',
        name: 'actionSchema',
        type: 'uint16',
      },
      {
        internalType: 'uint16',
        name: 'stateSchema',
        type: 'uint16',
      },
      {
        internalType: 'uint16',
        name: 'eventSchema',
        type: 'uint16',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'uint256',
        name: 'matchId',
        type: 'uint256',
      },
    ],
    name: 'getSquadStatus',
    outputs: [
      {
        components: [
          {
            internalType: 'bytes32[2]',
            name: 'commitments',
            type: 'bytes32[2]',
          },
          {
            internalType: 'bool[2]',
            name: 'committed',
            type: 'bool[2]',
          },
          {
            internalType: 'bool[2]',
            name: 'revealed',
            type: 'bool[2]',
          },
          {
            internalType: 'uint8[3][2]',
            name: 'unitTypes',
            type: 'uint8[3][2]',
          },
        ],
        internalType: 'struct SquadCodec.SquadStatus',
        name: '',
        type: 'tuple',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'uint256',
        name: 'matchId',
        type: 'uint256',
      },
    ],
    name: 'joinMatch',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'uint256',
        name: 'matchId',
        type: 'uint256',
      },
      {
        internalType: 'uint16',
        name: 'round',
        type: 'uint16',
      },
      {
        components: [
          {
            internalType: 'uint8',
            name: 'actionType',
            type: 'uint8',
          },
          {
            internalType: 'uint8',
            name: 'targetCell',
            type: 'uint8',
          },
          {
            internalType: 'uint8',
            name: 'targetUnit',
            type: 'uint8',
          },
          {
            internalType: 'uint8',
            name: 'pathLength',
            type: 'uint8',
          },
          {
            internalType: 'uint32',
            name: 'pathBits',
            type: 'uint32',
          },
        ],
        internalType: 'struct SquadCodec.Action[3]',
        name: 'actions',
        type: 'tuple[3]',
      },
      {
        internalType: 'bytes32',
        name: 'salt',
        type: 'bytes32',
      },
    ],
    name: 'revealActions',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'uint256',
        name: 'matchId',
        type: 'uint256',
      },
      {
        internalType: 'uint8[3]',
        name: 'unitTypes',
        type: 'uint8[3]',
      },
      {
        internalType: 'bytes32',
        name: 'salt',
        type: 'bytes32',
      },
    ],
    name: 'revealSquad',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'uint256',
        name: 'matchId',
        type: 'uint256',
      },
      {
        internalType: 'uint16',
        name: 'round',
        type: 'uint16',
      },
    ],
    name: 'settleRound',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'uint256',
        name: 'matchId',
        type: 'uint256',
      },
    ],
    name: 'startMatch',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;
