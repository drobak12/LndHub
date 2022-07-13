import { User } from '../class';
const config = require('../config');
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

async function run()
{
    const key_prefix = "bitcoin_address_for_"
    let keys = await redisClient.keys(key_prefix + '*');

    let result=[]
    for (let key of keys) 
    {
        const userid = key.replace(key_prefix, '');
        let U = new User(redisClient, bitcoinClient, lightningClient);
        U._userid = userid;
        result.push({'userid':userid, 'balance':await U.getBalance()});
    }
    
    console.log(result);
}

(async () => 
{
    console.log('All users balance - Date: ' + new Date());
    await run();
    process.exit();
})();
