/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/driftbear_custom_adaptor.json`.
 */
export type DriftbearCustomAdaptor = {
  "address": "4JW3mvrVGXpZZ3jxjw16o4REHnWuEGkbvLkPBg1RbFbQ",
  "metadata": {
    "name": "driftbearCustomAdaptor",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Custom adaptor scaffold for the DriftBear Ranger vault flow"
  },
  "instructions": [
    {
      "name": "deposit",
      "discriminator": [
        242,
        35,
        198,
        137,
        82,
        225,
        242,
        182
      ],
      "accounts": [
        {
          "name": "strategyAuthority",
          "signer": true
        },
        {
          "name": "strategy",
          "relations": [
            "position"
          ]
        },
        {
          "name": "vaultAssetMint"
        },
        {
          "name": "strategyTokenAta",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  114,
                  105,
                  102,
                  116,
                  98,
                  101,
                  97,
                  114,
                  45,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "strategy"
              }
            ]
          }
        },
        {
          "name": "driftState"
        },
        {
          "name": "driftUser",
          "writable": true
        },
        {
          "name": "driftUserStats",
          "writable": true
        },
        {
          "name": "spotMarket",
          "writable": true
        },
        {
          "name": "spotMarketVault",
          "writable": true
        },
        {
          "name": "spotMarketOracle"
        },
        {
          "name": "driftProgram"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ],
      "returns": "u64"
    },
    {
      "name": "initialize",
      "discriminator": [
        175,
        175,
        109,
        31,
        13,
        152,
        155,
        237
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "strategy"
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  114,
                  105,
                  102,
                  116,
                  98,
                  101,
                  97,
                  114,
                  45,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "strategy"
              }
            ]
          }
        },
        {
          "name": "driftState"
        },
        {
          "name": "driftUser",
          "writable": true
        },
        {
          "name": "driftUserStats",
          "writable": true
        },
        {
          "name": "driftProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "marketIndex",
          "type": "u16"
        }
      ]
    },
    {
      "name": "migratePosition",
      "discriminator": [
        15,
        132,
        59,
        50,
        199,
        6,
        251,
        46
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "strategy"
        },
        {
          "name": "position",
          "writable": true
        },
        {
          "name": "driftUser"
        },
        {
          "name": "driftUserStats"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "withdraw",
      "discriminator": [
        183,
        18,
        70,
        156,
        148,
        109,
        161,
        34
      ],
      "accounts": [
        {
          "name": "strategyAuthority",
          "signer": true
        },
        {
          "name": "strategy",
          "relations": [
            "position"
          ]
        },
        {
          "name": "vaultAssetMint"
        },
        {
          "name": "strategyTokenAta",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  114,
                  105,
                  102,
                  116,
                  98,
                  101,
                  97,
                  114,
                  45,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "strategy"
              }
            ]
          }
        },
        {
          "name": "driftState"
        },
        {
          "name": "driftUser",
          "writable": true
        },
        {
          "name": "driftUserStats",
          "writable": true
        },
        {
          "name": "spotMarket",
          "writable": true
        },
        {
          "name": "spotMarketVault",
          "writable": true
        },
        {
          "name": "spotMarketOracle"
        },
        {
          "name": "driftSigner"
        },
        {
          "name": "driftProgram"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ],
      "returns": "u64"
    }
  ],
  "accounts": [
    {
      "name": "adaptorPosition",
      "discriminator": [
        184,
        51,
        135,
        207,
        169,
        196,
        10,
        34
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "invalidDriftProgram",
      "msg": "The provided Drift program does not match mainnet Drift."
    },
    {
      "code": 6001,
      "name": "invalidDriftUser",
      "msg": "The provided Drift user account could not be decoded."
    },
    {
      "code": 6002,
      "name": "invalidSpotMarket",
      "msg": "The provided Drift spot market account could not be decoded."
    },
    {
      "code": 6003,
      "name": "invalidSpotBalanceType",
      "msg": "The Drift spot balance type is invalid."
    },
    {
      "code": 6004,
      "name": "tokenAmountOverflow",
      "msg": "The computed token amount exceeds the u64 range."
    },
    {
      "code": 6005,
      "name": "invalidDriftUserAuthority",
      "msg": "The Drift user authority does not match the strategy authority."
    },
    {
      "code": 6006,
      "name": "invalidDriftUserStatsAuthority",
      "msg": "The Drift user stats authority does not match the strategy authority."
    },
    {
      "code": 6007,
      "name": "invalidDriftUserPda",
      "msg": "The Drift user PDA does not match the expected subaccount PDA."
    },
    {
      "code": 6008,
      "name": "invalidDriftUserStatsPda",
      "msg": "The Drift user stats PDA does not match the expected PDA."
    },
    {
      "code": 6009,
      "name": "invalidDriftSubAccountId",
      "msg": "The Drift user subaccount does not match the initialized subaccount id."
    },
    {
      "code": 6010,
      "name": "invalidPositionPda",
      "msg": "The driftbear position PDA does not match the expected address."
    },
    {
      "code": 6011,
      "name": "invalidPositionOwner",
      "msg": "The driftbear position account is not owned by this program."
    },
    {
      "code": 6012,
      "name": "invalidPositionLayout",
      "msg": "The driftbear position account layout is invalid."
    },
    {
      "code": 6013,
      "name": "invalidPositionStrategy",
      "msg": "The driftbear position strategy does not match the expected address."
    },
    {
      "code": 6014,
      "name": "invalidDriftUserStatus",
      "msg": "The Drift user is in liquidation or bankrupt status."
    },
    {
      "code": 6015,
      "name": "unexpectedOpenOrders",
      "msg": "The Drift user has open orders that are unsupported by this strategy."
    },
    {
      "code": 6016,
      "name": "unexpectedPerpPosition",
      "msg": "The Drift user has perp exposure that is unsupported by this strategy."
    },
    {
      "code": 6017,
      "name": "unexpectedSpotPosition",
      "msg": "The Drift user has spot exposure outside the configured market."
    },
    {
      "code": 6018,
      "name": "invalidSpotMarketIndex",
      "msg": "The Drift spot market does not match the configured market index."
    },
    {
      "code": 6019,
      "name": "invalidSpotMarketVault",
      "msg": "The Drift spot market vault does not match the provided vault account."
    },
    {
      "code": 6020,
      "name": "invalidSpotMarketMint",
      "msg": "The Drift spot market mint does not match the vault asset mint."
    },
    {
      "code": 6021,
      "name": "invalidStrategyTokenOwner",
      "msg": "The strategy token account does not belong to the strategy authority."
    },
    {
      "code": 6022,
      "name": "invalidStrategyTokenMint",
      "msg": "The strategy token account mint does not match the vault asset mint."
    },
    {
      "code": 6023,
      "name": "unsupportedBorrowPosition",
      "msg": "This adaptor does not support borrow positions."
    },
    {
      "code": 6024,
      "name": "unexpectedSpotOrders",
      "msg": "This adaptor does not support open spot orders on the managed subaccount."
    }
  ],
  "types": [
    {
      "name": "adaptorPosition",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "strategy",
            "type": "pubkey"
          },
          {
            "name": "marketIndex",
            "type": "u16"
          },
          {
            "name": "subAccountId",
            "type": "u16"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "trackedBalance",
            "type": "u64"
          }
        ]
      }
    }
  ]
};
