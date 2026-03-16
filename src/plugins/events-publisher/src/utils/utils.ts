import { EventType } from "@drift-labs/sdk";
import { Serializer } from "@drift/common";

export const getEventTypeFromChannel = (
  channel: string,
): EventType | undefined => {
  const lowercaseChannel = channel.toLowerCase();
  switch (lowercaseChannel) {
    case "deposit":
    case "depositrecord":
      return "DepositRecord";
    case "fundingpayment":
    case "fundingpaymentrecord":
      return "FundingPaymentRecord";
    case "liquidation":
    case "liquidationrecord":
      return "LiquidationRecord";
    case "fundingrate":
    case "fundingraterecord":
      return "FundingRateRecord";
    case "orderaction":
    case "orderactionrecord":
      return "OrderActionRecord";
    case "order":
    case "orderrecord":
      return "OrderRecord";
    case "settlepnl":
    case "settlepnlrecord":
      return "SettlePnlRecord";
    case "newuser":
    case "newuserrecord":
      return "NewUserRecord";
    case "lp":
    case "lprecord":
      return "LPRecord";
    case "insurancefund":
    case "insurancefundrecord":
      return "InsuranceFundRecord";
    case "spotinterest":
    case "spotinterestrecord":
      return "SpotInterestRecord";
    case "insurancefundstake":
    case "insurancefundstakerecord":
      return "InsuranceFundStakeRecord";
    case "swap":
    case "swaprecord":
      return "SwapRecord";
    case "curve":
    case "curverecord":
      return "CurveRecord";
    case undefined:
    default:
      return undefined;
  }
};

export const getSerializerFromEventType = (eventType: EventType) => {
  switch (eventType) {
    case "DepositRecord":
      return Serializer.Serialize.Deposit;
    case "FundingPaymentRecord":
      return Serializer.Serialize.FundingPayment;
    case "LiquidationRecord":
      return Serializer.Serialize.Liquidation;
    case "FundingRateRecord":
      return Serializer.Serialize.FundingRate;
    case "OrderActionRecord":
      return Serializer.Serialize.OrderActionRecord;
    case "SettlePnlRecord":
      return Serializer.Serialize.SettlePnl;
    case "NewUserRecord":
      return Serializer.Serialize.NewUser;
    case "LPRecord":
      return Serializer.Serialize.LPRecord;
    case "InsuranceFundRecord":
      return Serializer.Serialize.InsuranceFundRecord;
    case "OrderRecord":
      return Serializer.Serialize.OrderRecord;
    case "SwapRecord":
      return Serializer.Serialize.SwapRecord;
    case "InsuranceFundStakeRecord":
      return Serializer.Serialize.InsuranceFundStakeRecord;
    case "SpotInterestRecord":
      return Serializer.Serialize.SpotInterestRecord;
    case "CurveRecord":
      return Serializer.Serialize.CurveRecord;
    default:
      return undefined;
  }
};
