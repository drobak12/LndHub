let http = require('http');
let config = require('../../config');

export class WalletMS
{

    constructor(){
    }

    async createAccount(userId){
        
        let options = {
            headers: {
                'x-consumer-custom-id': config.wallet.companyId,
                'Content-Type': 'application/json'
            },
            hostname: config.wallet.hostname,
            port: config.wallet.port,
            path: config.wallet.createAccountUrl,
            method: 'POST'
        }
        let body = {
            currency: "USDC",
            global_id: userId,
            additional_info:{
                source: "LightningChat"
            }
        }
        
        let data = await this.doPostRequest(options, body);
        return data.response.id;
        
    }

    async saveTransaction(walletId, userId, amount){
        
        let transactionUrl = config.wallet.transactionUrl.replace('{walletId}', walletId);
        let options = {
            headers: {
                'x-consumer-custom-id': config.wallet.companyId,
                'Content-Type': 'application/json'
            },
            hostname: config.wallet.hostname,
            port: config.wallet.port,
            path: transactionUrl,
            method: 'POST'
        }
        let body = [
            {
                status:"confirmed",
                amount: amount,
                additional_info:{
                    user_id: userId
                }
            }
        ]
        let data = await this.doPostRequest(options, body);
        return data.response[0];
    }

    async getBalance(walletId){
        let balanceUrl = config.wallet.balanceUrl.replace('{walletId}', walletId);
        let options = {
            headers: {
                'x-consumer-custom-id': config.wallet.companyId
            },
            hostname: config.wallet.hostname,
            port: config.wallet.port,
            path: balanceUrl,
            method: 'GET'
        }
        
        let data = await this.doGetRequest(options);
        return data.response;
    }

    activity(){
        return [
            {
                amount: 203,
                timestamp: 1657053914
            },
            {
                amount: 111,
                timestamp: 1657053914
            }
        ]
    }

    doPostRequest(options, data) {
        return new Promise((resolve, reject) => {
          const req = http.request(options, (res) => {
            res.setEncoding('utf8');
            let responseBody = '';
      
            res.on('data', (chunk) => {
                responseBody += chunk;
            });
      
            res.on('end', () => {
                resolve(JSON.parse(responseBody));
            });
          });
      
          req.on('error', (err) => {
            console.error('Error doPostRequest: ' + err);
            reject(err);
          });
      
          req.write(JSON.stringify(data));
          req.end();
        });
    }

    doGetRequest(options) {
        return new Promise((resolve, reject) => {
          const req = http.request(options, (res) => {
            res.setEncoding('utf8');
            let responseBody = '';
      
            res.on('data', (chunk) => {
                responseBody += chunk;
            });
      
            res.on('end', () => {
                resolve(JSON.parse(responseBody));
            });
          });
      
          req.on('error', (err) => {
            console.error('Error doGetRequest: ' + err);
            reject(err);
          });
      
          req.end();
        });
    }
      
}