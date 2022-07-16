import { User } from '../class';
const config = require('../config');
var crypto = require('crypto');
let bitcoinClient = require('../bitcoin');
let lightningClient = require('../lightning');
let Redis = require('ioredis');
let redisClient = new Redis(config.redis);
let identity_pubkey = false;
let internalFee = 0;
redisClient.info(function (err, info)
{
    if (err || !info)
    {
        console.error('redis failure');
        process.exit(5);
    }
});

lightningClient.getInfo({}, function (err, info)
{
    if (err)
    {
        console.error('lnd failure');
        console.dir(err);
        process.exit(3);
    }
    if (info)
    {
        //console.info('lnd getinfo:', info);
        if (!info.synced_to_chain && !config.forceStart)
        {
            console.error('lnd not synced');
            process.exit(4);
        }
        identity_pubkey = info.identity_pubkey;
    }
});

async function run(userid, amount)
{
    if (!userid)
    {
        console.log("Missing user id");
        return;
    }

    if (!amount)
    {
        console.log("Missing amount");
        return;
    }

    amount = +amount; //convert to number
    let amountInSats = amount;
    let currency = "SATS";

    console.log("Create bill from user: " + userid + "\namount: " + amount);

    let u = new User(redisClient, bitcoinClient, lightningClient);
    u._userid = userid;

    try
    {
        await u.clearBalanceCache();
        let userBalance = await u.getCalculatedBalance();
        console.log("Balance:" + userBalance);

        if (userBalance < +amountInSats + Math.ceil(amountInSats * internalFee))
        {
            console.log("not enough balance");
            return;
        }


        let crytpRandomBytes = crypto.randomBytes(20);
        let reqId = crytpRandomBytes.toString('base64').replace(/\+/g, "_");

        let bill = await u.createBill(reqId, amount, currency, amountInSats);
        console.log("bill: " + JSON.stringify(bill));

    } catch (Error)
    {
        console.log("Error: " + Error.message);
    }

}


(async () => 
{
    let userid = process.argv[2];
    let amount = process.argv[3];
    await run(userid, amount);
    process.exit();
})();
