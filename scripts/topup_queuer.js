let lightning = require('./lightning');
const config = require('./config');
const Redis = require('ioredis');
const redis = new Redis(config.redis);
const decoder = require('./btc-decoder');
//import { decodeRawHex } from '../btc-decoder';
redis.monitor(function (err, monitor) {
    monitor.on('monitor', function (time, args, source, database) {
        console.log('REDIS', JSON.stringify(args));
    });
});

(async () => {
    console.log('entering into async queuer');
    let last_txs_timestamp = await redis.get('last_txs_timestamp');

    console.log('last_txs_timestamp_value: ' + last_txs_timestamp);
    if (!last_txs_timestamp) {
        //last_txs_timestamp = Math.trunc(new Date() / 1000);
        last_txs_timestamp = 0;
    }

    let promise = new Promise((resolve, reject) => {
        lightning.getTransactions({}, (err, data) => {
            if (err) return reject(err);
            const { transactions } = data;
            const outTxns = [];
            // on lightning incoming transactions have no labels
            transactions
                .filter((tx) => tx.label === '')
                .map((tx) => {
                    const decodedTx = decoder.decodeRawHex(tx.raw_tx_hex, config.network);
                    decodedTx.outputs.forEach((vout) =>
                        outTxns.push({
                            user_id: redis.get('userid_by_address_' + vout.scriptPubKey.addresses[0]),
                            tx_id: tx.tx_hash,
                            category: 'receive',
                            confirmations: tx.num_confirmations,
                            amount: Number(vout.value),
                            address: vout.scriptPubKey.addresses[0],
                            time: tx.time_stamp
                        }),
                    );
                });
            resolve(outTxns);
        });
    });


    let txs = await promise;
    console.log(JSON.stringify(txs));
    console.log('total txs: ' + txs.length + ' timestamp: ' + last_txs_timestamp);
    for (let element of txs) {
        let userid = await redis.get('userid_by_address_' + element.address);
        console.log('this is the userid default: '+ userid);
        if (userid && element.time > last_txs_timestamp) {
            element.user_id = userid;
            redis.rpush('topup_queue', JSON.stringify(element));
        }
    }

    if (!txs && txs.length > 0) {
        console.log('setting up: ' + txs[0].time);
        await redis.set('last_txs_timestamp', txs[0].time);
    }
    process.exit(0);
})();
