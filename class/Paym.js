var crypto = require('crypto');
var lightningPayReq = require('bolt11');

export class Paym {
  constructor(redis, bitcoindrpc, lightning) {
    this._redis = redis;
    this._bitcoindrpc = bitcoindrpc;
    this._lightning = lightning;
    this._decoded = false;
    this._bolt11 = false;
    this._isPaid = null;
  }

  setInvoice(bolt11) {
    this._bolt11 = bolt11;
  }

  async decodePayReqViaRpc(invoice) {
    let that = this;
    return new Promise(function(resolve, reject) {
      that._lightning.decodePayReq({ pay_req: invoice }, function(err, info) {
        if (err) return reject(err);
        that._decoded = info;
        return resolve(info);
      });
    });
  }

  async queryRoutes() {
    if (!this._bolt11) throw new Error('bolt11 is not provided');
    if (!this._decoded) await this.decodePayReqViaRpc(this._bolt11);

    var request = {
      pub_key: this._decoded.destination,
      amt: this._decoded.num_satoshis,
      final_cltv_delta: 144,
      fee_limit: { fixed: Math.floor(this._decoded.num_satoshis * forwardFee) + 1 },
    };
    let that = this;
    return new Promise(function(resolve, reject) {
      that._lightning.queryRoutes(request, function(err, response) {
        if (err) return reject(err);
        resolve(response);
      });
    });
  }

  async sendToRouteSync(routes) {
    if (!this._bolt11) throw new Error('bolt11 is not provided');
    if (!this._decoded) await this.decodePayReqViaRpc(this._bolt11);

    let request = {
      payment_hash_string: this._decoded.payment_hash,
      route: routes[0],
    };

    console.log('sendToRouteSync:', { request });

    let that = this;
    return new Promise(function(resolve, reject) {
      that._lightning.sendToRouteSync(request, function(err, response) {
        if (err) reject(err);
        resolve(that.processSendPaymentResponse(response));
      });
    });
  }

  async estimateFee(routes) {
    let hasRoutes = routes.routes.length >= 1;
    let feeSats = 0;
    if (!hasRoutes) {
      return {
        hasRoutes: hasRoutes,
        amount_sats: this._decoded.num_satoshis,
        payment_hash: this._decoded.payment_hash,
      };
    } else {
      feeSats = Math.ceil(routes.routes[0].total_fees_msat / 1000); // TODO: What about another routes
      return {
        hasRoutes: hasRoutes,
        fee: feeSats,
        amount_sats: this._decoded.num_satoshis,
        payment_hash: this._decoded.payment_hash,
      };
    }
  }

  processSendPaymentResponse(payment) {
    if (payment && payment.payment_route && payment.payment_route.total_amt_msat) {
      // paid just now
      console.log('paym.processSendPaymentResponse. Option 1');

      // adding internal fee

      //console.log("paym.processSendPaymentResponse. total_amt_msat: "  + payment.payment_route.total_amt_msat );
      //console.log("paym.processSendPaymentResponse. total_fees_msat: "  + payment.payment_route.total_fees_msat );

      let original_invoice_amount_msat = Math.ceil(+payment.payment_route.total_amt_msat - payment.payment_route.total_fees_msat);
      let fee_to_add_msat = Math.ceil(+payment.payment_route.total_fees_msat + original_invoice_amount_msat * internalFee);
      payment.payment_route.total_amt_msat = original_invoice_amount_msat + fee_to_add_msat;
      payment.payment_route.total_fees_msat = fee_to_add_msat;
      payment.payment_route.total_fees = Math.ceil(payment.payment_route.total_fees_msat / 1000);
      payment.payment_route.total_amt = Math.ceil(payment.payment_route.total_amt_msat / 1000);

      //console.log("paym.processSendPaymentResponse. original_invoice_amount_msat: "  + original_invoice_amount_msat );
      //console.log("paym.processSendPaymentResponse. fee_to_add_msat: "  + fee_to_add_msat );
      //console.log("paym.processSendPaymentResponse. total_amt: "  + payment.payment_route.total_amt );
      //console.log("paym.processSendPaymentResponse. total_fees: " + payment.payment_route.total_fees);

      if (this._bolt11) payment.pay_req = this._bolt11;
      if (this._decoded) payment.decoded = this._decoded;
      this._isPaid = true;

      return payment;
    }

    if (payment.payment_error && payment.payment_error.indexOf('already paid') !== -1) {
      console.log('paym.processSendPaymentResponse. Option 2: TODO: compute fees correctly!');
      // already paid
      this._isPaid = true;
      if (this._decoded) {
        payment.decoded = this._decoded;
        if (this._bolt11) payment.pay_req = this._bolt11;
        // trying to guess the fee
        payment.payment_route = payment.payment_route || {};
        payment.payment_route.total_fees = Math.floor(this._decoded.num_satoshis * forwardFee); // we dont know the exact fee, so we use max (same as fee_limit)
        payment.payment_route.total_amt = this._decoded.num_satoshis;
      }
      return payment;
    }

    if (payment.payment_error && payment.payment_error.indexOf('unable to') !== -1) {
      // failed to pay
      this._isPaid = false;
    }

    if (payment.payment_error && payment.payment_error.indexOf('FinalExpiryTooSoon') !== -1) {
      this._isPaid = false;
    }

    if (payment.payment_error && payment.payment_error.indexOf('UnknownPaymentHash') !== -1) {
      this._isPaid = false;
    }

    if (payment.payment_error && payment.payment_error.indexOf('IncorrectOrUnknownPaymentDetails') !== -1) {
      this._isPaid = false;
    }

    if (payment.payment_error && payment.payment_error.indexOf('payment is in transition') !== -1) {
      this._isPaid = null; // null is default, but lets set it anyway
    }

    return payment;
  }

  /**
   * Returns NULL if unknown, true if its paid, false if its unpaid
   * (judging by error in sendPayment response)
   *
   * @returns {boolean|null}
   */
  getIsPaid() {
    return this._isPaid;
  }

  async attemptPayToRoute() {
    let routes = await this.queryRoutes();
    return await this.sendToRouteSync(routes.routes);
  }

  async listPayments() {
    return new Promise((resolve, reject) => {
      this._lightning.listPayments({}, function(err, response) {
        if (err) return reject(err);
        resolve(response);
      });
    });
  }

  async isExpired() {
    if (!this._bolt11) throw new Error('bolt11 is not provided');
    const decoded = await this.decodePayReqViaRpc(this._bolt11);
    return +decoded.timestamp + +decoded.expiry < +new Date() / 1000;
  }

  decodePayReqLocally(payReq) {
    this._decoded_locally = lightningPayReq.decode(payReq);
  }

  async getPaymentHash() {
    if (!this._bolt11) throw new Error('bolt11 is not provided');
    if (!this._decoded) await this.decodePayReqViaRpc(this._bolt11);

    return this._decoded['payment_hash'];
  }
}
