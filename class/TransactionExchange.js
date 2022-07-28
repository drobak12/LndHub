export default class TransactionExchange {
  constructor(transactionProviderId, transactionId, transactionAmount, currencyOrigin, currencyDestionation, amountExchange, fee, rate) {
    this._transactionProviderId = transactionProviderId;
    this._transactionId = transactionId;
    this._transactionAmount = transactionAmount;
    this._currencyOrigin = currencyOrigin;
    this._currencyDestionation = currencyDestionation;
    this._amountExchange = amountExchange;
    this._fee = fee;
    this._rate = rate;
  }
}
