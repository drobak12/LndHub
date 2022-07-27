import { User } from '../class';
const config = require('../config');
let lightningPayReq = require('bolt11');
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

async function run(userid, invoiceHash)
{
    if (!userid)
    {
        console.log("Missing user id");
        return;
    }

    if (!invoiceHash)
    {
        console.log("Missing invoiceHash");
        return;
    }

    console.log("Pay invoice from user: " + userid + "\nInvoice: " + invoiceHash);

    let u = new User(redisClient, bitcoinClient, lightningClient);
    u._userid = userid;



    //***********************************************/
    let userBalance;
    try
    {
        userBalance = await u.getCalculatedBalance();
    } catch (Error)
    {
        console.log("error running getCalculatedBalance():" + Error.message);
        return;
    }

    lightningClient.decodePayReq({ pay_req: invoiceHash }, async function (err, info)
    {
        if (err)
        {
            console.log("error running decodePayReq():" + err);
            return;
        }

        if (+info.num_satoshis === 0)
        {
            console.log("invoice of 0 satoshis");
            return;
        }

        //check  this is internal invoice
        if (identity_pubkey !== info.destination)
        {
            console.log("Error: external invoice");
            return;
        }

        let userid_payee = await u.getUseridByPaymentHash(info.payment_hash);
        if (!userid_payee)
        {
            console.log("Error in getUseridByPaymentHash");
            return;
        }
        console.log("Paying to:" + userid_payee);

        if (await u.getPaymentHashPaid(info.payment_hash))
        {
            // this internal invoice was paid, no sense paying it again
            await lock.releaseLock();
            {
                console.log("this internal invoice was paid, no sense paying it again");
                return;
            }
        }


        let UserPayee = new User(redisClient, bitcoinClient, lightningClient);
        UserPayee._userid = userid_payee; // hacky, fixme
        await UserPayee.clearBalanceCache();

        let fees_to_pay = Math.ceil(info.num_satoshis * internalFee);
        console.log("fees_to_pay:" + fees_to_pay);

        if (userBalance < +info.num_satoshis)
        {
            console.log("not enough balance");
            return;
        }

        
        return;
        /* WONT WORK!!!! 
        // sender spent his balance:
        await u.clearBalanceCache();
        await u.savePaidLndInvoice({
            timestamp: parseInt(+new Date() / 1000),
            type: 'paid_invoice',
            value: +info.num_satoshis + fees_to_pay,
            fee: fees_to_pay,
            memo: decodeURIComponent(info.description),
            pay_req: invoiceHash,
        });

        const invoice = new Invo(redisClient, bitcoinClient, lightningClient);
        invoice.setInvoice(invoiceHash);
        await invoice.markAsPaidInDatabase();

        // now, faking LND callback about invoice paid:
        const preimage = await invoice.getPreimage();
        if (preimage)
        {
            callPaymentInvoiceInternal({
                state: 'SETTLED',
                memo: info.description,
                r_preimage: Buffer.from(preimage, 'hex'),
                r_hash: Buffer.from(info.payment_hash, 'hex'),
                amt_paid_sat: +info.num_satoshis,
                fee: fees_to_pay,
                user: u.getUserId()
            });
        }
        */
    });


}


(async () => 
{
    let userid = process.argv[2];
    let invoice = process.argv[3];
    await run(userid, invoice);



    //process.exit();
})();
