import { WalletMS } from './external/WalletMS';
import { Exchange } from './external/Exchange';
import { RipioMS } from './external/RipioMS';
import { MockMS } from './external/MockMS';
const config = require('../config');

let logger = require('../utils/logger');

export class Wallet
{

    constructor(userid, currency, redis){
        this._userid = userid;
        this._masterAccount = config.wallet.masterAccount;
        this._currency = currency;
        this._redis = redis;
        this._walletMs = new WalletMS(this._redis);
        this._exchange = new Exchange(this._redis);
        this._exchangeService = this._createInstanceExchange(redis);
    }

    _createInstanceExchange(redis){
        if(config.exchangeMs.mockEnable){
            logger.log('Creating MockMS instance for Exchange Service', [])
            return new MockMS(redis);
        }else {
            logger.log('Creating RipioMS instance for Exchange Service', [])
            return new RipioMS(redis);
        }
    }

    async loadAccount(){
        await this._walletMs.createAccount(this._userid);
        await this._exchangeService.createAccount(this._userid);
    }

    async getBalance(){
        return await this._walletMs.getBalance(await this.getWalletId(this._userid));
    }

    async getBalanceInSats(){
        let walletBalance = await this._walletMs.getBalance(await this.getWalletId(this._userid));
        return await this._exchange.convertToCurrency(walletBalance, this._currency, 'SATS');
    }

    async loadBalanceAmountToWallet(amountSats, transactionId){
        let amountBtc = await this._exchange.convertToCurrency(amountSats, 'SATS', 'BTC');
        let response = await this._exchangeService.loadStableCoin(this._userid, transactionId, amountBtc, 'BTC', this._currency);
        
        let walletIdMasterAccount = await this.getWalletId(this._masterAccount);
        let walletIdUser = await this.getWalletId(this._userid);
        let amountExchange = response._amountExchange;
        let currencyOrigin = 'BTC';
        let currencyDestination = this._currency;
        let transactionProviderId =  response._transactionProviderId;
        let fee = response._fee;
        
        await this._walletMs.saveTransaction(walletIdMasterAccount, this._masterAccount, amountExchange, currencyOrigin, currencyDestination, transactionId, transactionProviderId, fee);
        return await this._walletMs.saveTransaction(walletIdUser, this._userid, amountExchange, currencyOrigin, currencyDestination, transactionId, transactionProviderId, fee);
    }
    
    async loadStableCoinToBalance(amountSats, transactionId){
        let amountUSDC = await this._exchange.convertToCurrency(amountSats, 'SATS', this._currency);
        let response = await this._exchangeService.unloadStableCoin(this._userid, transactionId, amountUSDC, this._currency, 'BTC');

        let walletIdMasterAccount = await this.getWalletId(this._masterAccount);
        let walletIdUser = await this.getWalletId(this._userid);
        let amountExchange = response._transactionAmount*-1;
        let currencyOrigin = this._currency;
        let currencyDestination = 'BTC';
        let transactionProviderId =  response._transactionProviderId;
        let fee = response._fee;

        await this._walletMs.saveTransaction(walletIdMasterAccount, this._masterAccount, amountExchange, currencyOrigin, currencyDestination, transactionId, transactionProviderId, fee);
        let transaction = await this._walletMs.saveTransaction(walletIdUser, this._userid, amountExchange,currencyOrigin, currencyDestination, transactionId, transactionProviderId, fee);
        transaction.amountSats = Math.round(await this._exchange.convertToCurrency(response._transactionAmount, this._currency, 'SATS'));
        return transaction;
    }

    async saveWalletAccount(walletId){
        if(!config.exchangeMs.mockEnable)
            await this._redis.set('wallet_account_' + this._userid, new String(walletId));
    }

    async getWalletId(userId){
        return this._walletMs._getWalletId(userId);
    }

    async _getReferenceId(userId){
        return await this.exchangeMs._getReferenceId(userId);
    }

    

    async getCurrency(){
        return this._currency;
    }

}