import { IExchangeService } from './IExchangeService';
import TransactionExchange from '../TransactionExchange';
import { HttpUtils } from './Http';

let logger = require('../../utils/logger');

let config = require('../../config');
let https = require('https');
let request = require('request');

export class RipioMS extends IExchangeService
{

    constructor(redis){
        super();
        this._redis = redis;
        this._httpUtils = new HttpUtils();
    }

    async createAccount(userId){
        if(!await this._getReferenceId(userId)){
            let exchangeReferenceId = await this._performCreateAccount(userId);
            await this.saveExchangeAccount(exchangeReferenceId);
        }
    }

    async loadStableCoin(userId, transactionId, amount, currencyOrigin, currencyDestination){

        userId = userId.replace('.', '_');
        userId = 'WHATSAPP_573016347804'; //TODO: Remove:: Currently WHATSAPP_573016347804 has balance. This is the unique account
        
        let pair = currencyOrigin + '_' + currencyDestination;
        let loadResponse = await this._loadBalanceToUser(userId, amount, currencyOrigin, transactionId);
        let quote = await this._createQuote(pair, transactionId);
        let response = await this._executeQuote(quote.id, amount, transactionId, userId);
        
        return new TransactionExchange(
            response.txn_id, transactionId, amount, currencyOrigin, currencyDestination, 
            response.quote_amount, response.charged_fee, response.rate
        )
    }

    async unloadStableCoin(userId, transactionId, amount, currencyOrigin, currencyDestination){

        userId = userId.replace('.', '_');
        amount = amount.toFixed(8);
        let pair = currencyOrigin + '_' + currencyDestination;
        let quote = await this._createQuote(pair, transactionId);

        let response = await this._executeQuote(quote.id, amount, transactionId, userId);
        
        return new TransactionExchange(
            response.txn_id, transactionId, amount, currencyOrigin, currencyDestination, 
            response.quote_amount, response.charged_fee, response.rate
        )
    }

    async retrieveBalance(userId, currency){
        
        userId = userId.replace('.', '_');
        let token = await this._retrieveToken();
        let url = config.exchangeMs.balanceUrl.replace('{user-id}', userId);
        let options = {
            headers: {
                'Authorization': token,
                'Content-Type': 'application/json'
            },
            hostname: config.exchangeMs.hostname,
            port: config.exchangeMs.port,
            path: url,
            method: 'GET'
        };
        
        let data = await this._httpUtils.doHttpsGetRequest(options);
        await this.verifyError(data);
        for (let item of data) {
            if(item.currency === currency){
                return item.balance;
            }
        }
        return 0;
    }

    async _loadBalanceToUser(userId, amount, currency, transactionId){
        return {
            status: 'OK'
        };
    }

    async _executeQuote(quoteId, amount, transactionId, userId){
        let token = await this._retrieveToken();
        let swapQuoteExecuteUrl = config.exchangeMs.swapQuoteExecutionUrl.replace('{swap_quote_id}',quoteId);

        let options = {
            headers: {
                'Authorization': token,
                'Content-Type': 'application/json'
            },
            hostname: config.exchangeMs.hostname,
            port: config.exchangeMs.port,
            path: swapQuoteExecuteUrl,
            method: 'POST'
        }
        let body = {
            base_amount: amount,
            end_user_id: userId,
            external_ref: transactionId
        }
        
        let data = await this._httpUtils.doHttpsPostRequest(options, body);
        await this.verifyError(data);
        return data;
    }

    async _createQuote(pair, transactionId){
        let token = await this._retrieveToken();
        let options = {
            headers: {
                'Authorization': token,
                'Content-Type': 'application/json'
            },
            hostname: config.exchangeMs.hostname,
            port: config.exchangeMs.port,
            path: config.exchangeMs.swapQuoteUrl,
            method: 'POST'
        }
        let body = {
            pair: pair,
            external_ref: transactionId
        }
        
        let data = await this._httpUtils.doHttpsPostRequest(options, body);
        await this.verifyError(data);
        return data;
    }

    async _retrieveToken(){
        let token = await this._redis.get('ripio_token');
        if(!token){
            let data = await this._createToken();
            token = data.access_token;
            await this._redis.set('ripio_token', token);
            let expireAt = parseInt(+new Date() / 1000) + data.expires_in - 60;
            await this._redis.expireat('ripio_token', expireAt);
            
        }
        return 'Bearer ' + token;
    }

    async _createToken(){

        var options = {
            url: config.exchangeMs.protocol + '://' + config.exchangeMs.hostname + config.exchangeMs.authenticationUrl
        };

        let form = {
            grant_type: config.exchangeMs.grantType,
            client_id: config.exchangeMs.clientId,
            client_secret: config.exchangeMs.clientSecret
        }
        
        let data = await this._httpUtils.doHttpsPostFormRequest(options, form);
        await this.verifyError(data);
        return data
    }

    async verifyError(data){
        if(data.code){
            throw {name : "ExchangeServiceException", code: data.code, message : data.detail.message}
        }
    }

    async _saveExchangeAccount(referenceId){
        await this._redis.set('exchange_account_' + this._userid, new String(referenceId));
    }

    async _getReferenceId(userId){
        return await this._redis.get('exchange_account_' + userId);
    }

    async _performCreateAccount(userId){
        userId = userId.replace('.', '_');
        let token = await this._retrieveToken();
        let options = {
            headers: {
                'Authorization': token,
                'Content-Type': 'application/json'
            },
            hostname: config.exchangeMs.hostname,
            port: config.exchangeMs.port,
            path: config.exchangeMs.createAccountUrl,
            method: 'POST'
        };
        let body = {
            external_ref: userId
        };
        
        let data = await this._httpUtils.doHttpsPostRequest(options, body);
        return data;
    }
      
}