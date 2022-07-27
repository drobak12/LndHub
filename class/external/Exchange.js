let http = require('http');
let config = require('../../config');
let logger = require('../../utils/logger');

export class Exchange
{

    constructor(redis){
      this._redis = redis;
    }

    async convertToCurrency(amount, currencyFrom, currencyTo)
    {
        if (!currencyFrom) currencyFrom = "SATS";
        if (!currencyTo) currencyTo = "SATS";

        let sats = await this._convertAmountToSatoshis(amount, currencyFrom);

        let convertRatio = await this._convertAmountToSatoshis(1, currencyTo);
        return sats / convertRatio;
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

    async _convertAmountToSatoshis(amount, currency)
    {
        if (!currency)
            return amount;
        if ("SATS" == currency)
            return amount;

        let ratio = await this._getConvertRatioToSatoshis(currency);
        return ratio * amount;
    };

    async _getConvertRatioToSatoshis(currency)
    {
        if ("SATS" == currency)
            return 1;
        if ("BTC" == currency)
            return 100000000;
        if ("EURO" == currency)
            currency = "EUR";

        let key = "convert_ratio_BTC_" + currency;
        let convertRatio = await this._redis.get(key)
        logger.log('api.getConvertRatioToSatoshis', ['key:' + key, 'convertRatio: ' + convertRatio]);

        if (!convertRatio)
        {
            logger.error('Error in getConvertRatioToSatoshis', [currency]);
            throw 'Exchange::getConvertRatioToSatoshis:: Ratio is not defined'; 
        }
        return 100000000.0 / convertRatio;

    }

}