import Decimal from "decimal.js";
import { DriftExecutor } from "../drift/executor";

// Mock @drift-labs/sdk
jest.mock("@drift-labs/sdk", () => {
  const BN = require("bn.js");
  return {
    DriftClient: jest.fn(),
    MarketType: { PERP: 0, SPOT: 1 },
    PositionDirection: { LONG: { long: {} }, SHORT: { short: {} } },
    OrderType: { LIMIT: { limit: {} }, MARKET: { market: {} } },
    getOrderParams: jest.fn((params) => params),
    getMarketOrderParams: jest.fn((params) => params),
    BN,
    PRICE_PRECISION: new BN(1e6),
    convertToNumber: (bn: any, precision: any) => {
      if (bn && bn._mockValue !== undefined) return bn._mockValue;
      return Number(bn.toString()) / Number(precision.toString());
    },
  };
});

// Silence logger
jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

function mockBN(value: number) {
  const BN = require("bn.js");
  const bn = new BN(Math.round(value));
  bn._mockValue = value;
  bn.isZero = () => value === 0;
  bn.isNeg = () => value < 0;
  bn.abs = () => mockBN(Math.abs(value));
  bn.mul = (other: any) => mockBN(value * Number(other.toString()));
  bn.div = (other: any) => mockBN(Math.round(value / Number(other.toString())));
  return bn;
}

function makeDriftClientMock() {
  return {
    convertToPerpPrecision: jest.fn((amount: number) => mockBN(amount * 1e9)),
    getOracleDataForPerpMarket: jest.fn(() => ({
      price: mockBN(150 * 1e6), // $150 oracle price in PRICE_PRECISION
    })),
    getPerpMarketAccount: jest.fn(() => ({
      amm: {
        lastOracleConfPct: mockBN(0),
        lastOracleReservePriceSpreadPct: mockBN(0),
      },
    })),
    getSpotMarketAccount: jest.fn(() => ({
      orderStepSize: mockBN(1000),
    })),
    getCancelOrdersIx: jest.fn().mockResolvedValue({ type: "cancel" }),
    getPlaceSpotOrderIx: jest.fn().mockResolvedValue({ type: "spotOrder" }),
    getPlacePerpOrderIx: jest.fn().mockResolvedValue({ type: "perpOrder" }),
    cancelAndPlaceOrders: jest.fn().mockResolvedValue("tx-cancel-place"),
    placePerpOrder: jest.fn().mockResolvedValue("tx-perp"),
    placeSpotOrder: jest.fn().mockResolvedValue("tx-spot"),
    cancelOrdersByIds: jest.fn().mockResolvedValue(undefined),
    modifyOrder: jest.fn().mockResolvedValue(undefined),
    getUser: jest.fn(() => ({
      getPerpPosition: jest.fn(() => null),
      getTokenAmount: jest.fn(() => mockBN(0)),
      getUserAccount: jest.fn(() => ({})),
    })),
    getUserAccountPublicKey: jest.fn().mockResolvedValue("pubkey"),
    getSettlePNLsIxs: jest.fn().mockResolvedValue([]),
    wallet: { publicKey: { toBase58: () => "mock-pubkey" } },
    opts: {},
    txSender: {
      getVersionedTransaction: jest.fn().mockResolvedValue("mock-tx"),
      sendVersionedTransaction: jest.fn().mockResolvedValue({ txSig: "tx-123" }),
    },
  } as any;
}

describe("DriftExecutor", () => {
  let executor: DriftExecutor;
  let client: ReturnType<typeof makeDriftClientMock>;
  let sorClient: { isConfigured: jest.Mock; getOrderMetadata: jest.Mock };

  beforeEach(() => {
    client = makeDriftClientMock();
    sorClient = {
      isConfigured: jest.fn(() => false),
      getOrderMetadata: jest.fn(),
    };
    executor = new DriftExecutor(client, 50_000, sorClient as any);
  });

  // ── atomicCancelAndEnterDeltaNeutral ──────────────────────────────

  describe("atomicCancelAndEnterDeltaNeutral", () => {
    it("builds cancel + spot + perp IXs for short perp direction", async () => {
      await executor.atomicCancelAndEnterDeltaNeutral(
        "SOL",
        new Decimal("100"),
        "short"
      );

      expect(client.getCancelOrdersIx).toHaveBeenCalled();
      expect(client.getPlaceSpotOrderIx).toHaveBeenCalled();
      expect(client.getPlacePerpOrderIx).toHaveBeenCalled();
    });

    it("builds cancel + spot + perp IXs for long perp direction", async () => {
      await executor.atomicCancelAndEnterDeltaNeutral(
        "SOL",
        new Decimal("100"),
        "long"
      );

      expect(client.getCancelOrdersIx).toHaveBeenCalled();
      expect(client.getPlaceSpotOrderIx).toHaveBeenCalled();
      expect(client.getPlacePerpOrderIx).toHaveBeenCalled();
    });

    it("throws on unknown asset", async () => {
      await expect(
        executor.atomicCancelAndEnterDeltaNeutral(
          "DOGE",
          new Decimal("100"),
          "short"
        )
      ).rejects.toThrow("Unknown asset: DOGE");
    });

    it("throws on zero oracle price", async () => {
      client.getOracleDataForPerpMarket.mockReturnValue({
        price: mockBN(0),
      });

      await expect(
        executor.atomicCancelAndEnterDeltaNeutral(
          "SOL",
          new Decimal("100"),
          "short"
        )
      ).rejects.toThrow("Invalid oracle price");
    });

    it("defaults perpDirection to short", async () => {
      await executor.atomicCancelAndEnterDeltaNeutral(
        "SOL",
        new Decimal("50")
      );

      // Should have called the IXs (no error = valid direction)
      expect(client.getPlacePerpOrderIx).toHaveBeenCalled();
    });

    it("uses SOR metadata for spot leg pricing when configured", async () => {
      sorClient.isConfigured.mockReturnValue(true);
      sorClient.getOrderMetadata.mockResolvedValue({
        total_collateral: 101,
        total_size: 0.5,
        venues: [],
      });

      await executor.atomicCancelAndEnterDeltaNeutral(
        "SOL",
        new Decimal("100"),
        "short"
      );

      expect(sorClient.getOrderMetadata).toHaveBeenCalled();
      expect(client.getPlaceSpotOrderIx).toHaveBeenCalled();
    });
  });

  // ── atomicDeltaNeutralExit ────────────────────────────────────────

  describe("atomicDeltaNeutralExit", () => {
    it("returns empty string when no positions to close", async () => {
      const result = await executor.atomicDeltaNeutralExit("SOL");
      expect(result).toBe("");
    });

    it("closes positive perp and positive spot correctly", async () => {
      // Long perp (positive base) + long spot (positive token)
      const mockUser = {
        getPerpPosition: jest.fn(() => ({
          baseAssetAmount: mockBN(1e9), // positive = long
        })),
        getTokenAmount: jest.fn(() => mockBN(1e9)), // positive = holding
      };
      client.getUser.mockReturnValue(mockUser);

      await executor.atomicDeltaNeutralExit("SOL");

      // Should have called cancel + close perp + close spot = 3 IXs
      expect(client.getCancelOrdersIx).toHaveBeenCalled();
      expect(client.getPlacePerpOrderIx).toHaveBeenCalled();
      expect(client.getPlaceSpotOrderIx).toHaveBeenCalled();
    });

    it("closes negative perp and negative spot correctly (bi-directional)", async () => {
      // Short perp (negative base) + short spot (negative token = borrowed)
      const mockUser = {
        getPerpPosition: jest.fn(() => ({
          baseAssetAmount: mockBN(-1e9), // negative = short
        })),
        getTokenAmount: jest.fn(() => mockBN(-1e9)), // negative = borrowed
      };
      client.getUser.mockReturnValue(mockUser);

      await executor.atomicDeltaNeutralExit("ETH");

      expect(client.getCancelOrdersIx).toHaveBeenCalled();
      expect(client.getPlacePerpOrderIx).toHaveBeenCalled();
      expect(client.getPlaceSpotOrderIx).toHaveBeenCalled();
    });

    it("throws on unknown asset", async () => {
      await expect(
        executor.atomicDeltaNeutralExit("DOGE")
      ).rejects.toThrow("Unknown asset: DOGE");
    });
  });

  // ── placeMarketOrderWithSlippage ──────────────────────────────────

  describe("placeMarketOrderWithSlippage", () => {
    it("places a slippage-protected long perp order", async () => {
      const BN = require("bn.js");
      await executor.placeMarketOrderWithSlippage({
        asset: "SOL",
        marketType: "perp",
        direction: "long",
        baseAmount: new BN(1e9),
        slippageBps: 50,
      });

      expect(client.placePerpOrder).toHaveBeenCalled();
    });

    it("places a slippage-protected short spot order", async () => {
      const BN = require("bn.js");
      await executor.placeMarketOrderWithSlippage({
        asset: "BTC",
        marketType: "spot",
        direction: "short",
        baseAmount: new BN(1e6),
      });

      expect(client.placeSpotOrder).toHaveBeenCalled();
    });

    it("throws on zero oracle price", async () => {
      const BN = require("bn.js");
      client.getOracleDataForPerpMarket.mockReturnValue({
        price: mockBN(0),
      });

      await expect(
        executor.placeMarketOrderWithSlippage({
          asset: "SOL",
          marketType: "perp",
          direction: "long",
          baseAmount: new BN(1e9),
        })
      ).rejects.toThrow("Invalid oracle price");
    });
  });

  // ── cancelAndPlacePerp ────────────────────────────────────────────

  describe("cancelAndPlacePerp", () => {
    it("cancels and places new orders atomically", async () => {
      await executor.cancelAndPlacePerp("SOL", [
        {
          direction: "long",
          baseAmount: new Decimal("1.5"),
          price: new Decimal("150"),
        },
      ]);

      expect(client.cancelAndPlaceOrders).toHaveBeenCalled();
    });

    it("throws on unknown perp", async () => {
      await expect(
        executor.cancelAndPlacePerp("DOGE", [])
      ).rejects.toThrow("Unknown perp: DOGE");
    });
  });

  // ── settlePnl ─────────────────────────────────────────────────────

  describe("settlePnl", () => {
    it("does not execute when there are no IXs", async () => {
      client.getSettlePNLsIxs.mockResolvedValue([]);

      await executor.settlePnl([0, 1, 2]);

      // Should not have called executeBatchedIxs
      expect(client.txSender.getVersionedTransaction).not.toHaveBeenCalled();
    });
  });

  // ── cancelAllOrders ───────────────────────────────────────────────

  describe("cancelAllOrders", () => {
    it("cancels all orders", async () => {
      (client as any).cancelOrders = jest.fn().mockResolvedValue(undefined);

      await executor.cancelAllOrders();

      expect((client as any).cancelOrders).toHaveBeenCalledWith(null, null, null);
    });
  });

  // ── modifyOrder ───────────────────────────────────────────────────

  describe("modifyOrder", () => {
    it("modifies order price", async () => {
      await executor.modifyOrder(42, new Decimal("155.50"));

      expect(client.modifyOrder).toHaveBeenCalledWith(
        expect.objectContaining({ orderId: 42 })
      );
    });
  });
});
