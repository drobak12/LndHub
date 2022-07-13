import { User } from '../class';
const config = require('../config');
let lightningPayReq = require('bolt11');
let bitcoinClient = require('../bitcoin');
let lightningClient = require('../lightning');
let Redis = require('ioredis');
let redisClient = new Redis(config.redis);

redisClient.info(function (err, info)
{
    if (err || !info)
    {
        console.error('redis failure');
        process.exit(5);
    }
});

async function run(userid)
{
    if (!userid)
    {
        console.log("invalid user id: " + userid);
        return;
    }

    console.log("Processing user: " + userid);

    let U = new User(redisClient, bitcoinClient, lightningClient);
    U._userid = userid;

    let userinvoices = await U.getUserInvoices();
    console.log("Number of invoices: " + userinvoices.length);

    let result = []
    for (let invoice of userinvoices)
    {
        invoice.decoded = lightningPayReq.decode(invoice.payment_request);
        result.push(invoice);
    }
    console.log(JSON.stringify(result, null, 4));
}


(async () => 
{
    let userid = process.argv[2];
    await run(userid);
    process.exit();
})();
