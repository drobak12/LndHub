import { WalletMS } from './external/WalletMS';
import { Exchange } from './external/Exchange';

export class Wallet
{

    constructor(userid, currency, redis){
        this._userid = userid;
        this._currency = currency;
        this._redis = redis;
        this._walletMs = new WalletMS();
        this._exchange = new Exchange(this._redis);
    }

    async loadAccount(){
        if(!await this.getWalletId()){
            let walletId = await this._walletMs.createAccount(this._userid);
            await this.saveWalletAccount(walletId)
        }
    }

    async getBalance(){
        return this._walletMs.getBalance(await this.getWalletId());
    }

    async getBalanceInSats(){
        let walletBalance = await this._walletMs.getBalance(await this.getWalletId());
        return await this._exchange.toSats(walletBalance, this._currency)
    }

    async loadBalanceAmountToWallet(amountSats){
        let stableCoins = await this._exchange.satsTo(amountSats, this._currency);
        console.log('Savinds stable coins: ' + stableCoins);
        return await this._walletMs.saveTransaction(await this.getWalletId(), this._userid, stableCoins);
    }

    async loadStableCoinToBalance(amountSats){
        let stableCoins = await this._exchange.satsTo(amountSats, this._currency);
        let transaction = await this._walletMs.saveTransaction(await this.getWalletId(), this._userid, stableCoins*-1);
        transaction.amountSats = Math.round(await this._exchange.toSats(stableCoins, this._currency));
        return transaction;
    }

    async saveWalletAccount(walletId){
        await this._redis.set('wallet_account_' + this._userid, new String(walletId));
    }

    async getWalletId(){
        let data = await this._redis.get('wallet_account_' + this._userid);
        return parseInt(data);
    }

    async getCurrency(){
        return this._currency;
    }

}