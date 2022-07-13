let http = require('http');
let config = require('../../config');
let logger = require('../../utils/logger');

export class Exchange
{

    constructor(redis){
      this._redis = redis;
    }

    async satsTo(amountSats, currency)
    {
        if (!currency)
            return amountSats;
        if ("SATS" == currency)
            return amountSats;

        let amountBtc = amountSats / 100000000;
        let ratio = await this.getRatioByCurrency( 'BTC_' + currency);
        return ratio * amountBtc;
    };

    async toSats(amount, currency)
    {
        if (!currency)
            return amount;

        let ratio = await this.getRatioByCurrency( currency + '_BTC');
        return ratio * 100000000 * amount;
    };

    async getRatioByCurrency(currencyConvert){
      let key = "convert_ratio_" + currencyConvert;
      return await this._redis.get(key);
    }

}