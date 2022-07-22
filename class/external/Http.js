let logger = require('../../utils/logger');
let https = require('https');
let http = require('http');
let request = require('request');

export class HttpUtils {

    constructor(){

    }

    async doHttpPostRequest(options, data) {
        return new Promise((resolve, reject) => {
          const req = http.request(options, (res) => {
            res.setEncoding('utf8');
            let responseBody = '';
      
            res.on('data', (chunk) => {
                responseBody += chunk;
            });
      
            res.on('end', () => {
                logger.log('Response Service: ' + responseBody);
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

    async doHttpGetRequest(options) {
        return new Promise((resolve, reject) => {
          const req = http.request(options, (res) => {
            res.setEncoding('utf8');
            let responseBody = '';
      
            res.on('data', (chunk) => {
                responseBody += chunk;
            });
      
            res.on('end', () => {
                logger.log('Response Service: ' + responseBody);
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

    async doHttpsPostFormRequest(options, formData) {
        return new Promise((resolve, reject) => {
            request.post({url:options.url, formData: formData}, function optionalCallback(err, httpResponse, body) {
                if (err) {
                    reject(err);
                }
                logger.log('Response Service: ' + body);
                resolve(JSON.parse(body));
              });
        });
    }

    async doHttpsPostRequest(options, data) {
        return new Promise((resolve, reject) => {
          const req = https.request(options, (res) => {
            res.setEncoding('utf8');
            let responseBody = '';
      
            res.on('data', (chunk) => {
                responseBody += chunk;
            });
      
            res.on('end', () => {
                logger.log('Response Service: ' + responseBody);
                resolve(JSON.parse(responseBody));
            });
          });
      
          req.on('error', (err) => {
            logger.error('Error doPostRequest: ' + err);
            reject(err);
          });
      
          req.write(JSON.stringify(data));
          req.end();
        });
    }

    async doHttpsGetRequest(options) {
        return new Promise((resolve, reject) => {
          const req = https.request(options, (res) => {
            res.setEncoding('utf8');
            let responseBody = '';
      
            res.on('data', (chunk) => {
                responseBody += chunk;
            });
      
            res.on('end', () => {
                logger.log('Response Service: ' + responseBody);
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