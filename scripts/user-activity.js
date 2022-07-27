//Structure: node_modules/.bin/babel-node <file> <destination-folder>
//Execute with: node_modules/.bin/babel-node scripts/user-activity.js /tmp


const fs = require('fs');

import { User } from '../class';
const config = require('../config');

let bitcoinclient = require('../bitcoin');
let lightning = require('../lightning');
let logger = require('../utils/logger');

var Redis = require('ioredis');
var redis = new Redis(config.redis);


(async () => {
    logger.log('Executing activity user report....')
    let report = [];
    let keys = await redis.keys('bitcoin_address_for_*');
    let users = [];
    for( let key of keys ){
        let user = String(key).replace('bitcoin_address_for_','');
        users.push(user);
    }
    
    for(let user of users){
        try{
            let u = new User(redis, bitcoinclient, lightning);
            u.loadByAuthorization(user);
    
            let balance = await u.getBalance();
            let txs = await u.getTxs();
            
            report.push({
                user: user,
                balance: balance,
                txs: txs 
            });
            
        }catch(Error){
            logger.error('Error procesing user... Message: ' + Error, [user]);
        }
    }

    let date = new Date();
    let path = process.argv[2];
    let prefixDate = String(date.getFullYear()) + String(date.getMonth()+1) + String(date.getDay()) + String(date.getHours()) + String(date.getMinutes());
    let reportName = path + '/report-' + prefixDate;

    let writeStream = fs.createWriteStream(reportName);
    writeStream.write(JSON.stringify(report));
    logger.log('Writing file report...' + reportName);
    writeStream.on('close', () => {
        process.exit();
    });

    writeStream.end();

})();