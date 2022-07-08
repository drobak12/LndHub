import { WalletMS } from './external/WalletMS';
import { Exchange } from './external/Exchange';

export class Wallet
{

    constructor(userid, currency, redis){
        this._userid = userid;
        this._currency = currency;
        this._redis = redis;
        this._walletMs = new WalletMS();
        this._exchange = new Exchange;
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

    async loadBalanceAmountToStableCoin(amount){
        let stableCoins = await this._exchange.swapSatsToUSDC(amount);
        return await this._walletMs.saveTransaction(await this.getWalletId(), this._userid, stableCoins);
    }

    async loadStableCoinToBalance(amount){
        let transaction = await this._walletMs.saveTransaction(await this.getWalletId(), this._userid, amount*-1);
        transaction.amountSats = await this._exchange.swapUSDCToSats(amount);
        return transaction;
    }

    async saveWalletAccount(walletId){
        await this._redis.set('wallet_account_' + this._userid, new String(walletId));
    }

    async getWalletId(){
        let data = await this._redis.get('wallet_account_' + this._userid);
        return parseInt(data);
    }

}