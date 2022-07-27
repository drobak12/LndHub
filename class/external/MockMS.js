import { IExchangeService } from './IExchangeService';
import { Exchange } from './Exchange';
import TransactionExchange from '../TransactionExchange';
import { HttpUtils } from './Http';
import {v4 as uuidv4} from 'uuid';

export class MockMS extends IExchangeService
{

    constructor(redis){
        super();
        this._redis = redis;
        this._exchange = new Exchange(this._redis);
        this._httpUtils = new HttpUtils();
    }

    async createAccount(userId){
        return 0;
    }

    async loadStableCoin(userId, transactionId, amountBtc, currencyOrigin, currencyDestination){
        let amountUSDC = await this._exchange.convertToCurrency(amountBtc, 'BTC', 'USDC');
        return new TransactionExchange(
            uuidv4(), transactionId, amountBtc, currencyOrigin, currencyDestination, 
            amountUSDC, 0, 0
        );
    }

    async unloadStableCoin(userId, transactionId, amountUSDC, currencyOrigin, currencyDestination){
        console.log('===' + amountUSDC + ' amountUSDC');
        let amountBTC = await this._exchange.convertToCurrency(amountUSDC, 'USDC', 'BTC');
        console.log('===' + amountBTC + ' amountBTC');
        return new TransactionExchange(
            uuidv4(), transactionId, amountUSDC, currencyOrigin, currencyDestination, 
            amountBTC, 0, 0
        );
    }

    async retrieveBalance(userId, currency){
        return 0;
    }
      
}