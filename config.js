const bitcoin = require('bitcoinjs-lib')
let config = {
  network: bitcoin.networks.regtest,
  //balance_expire_seconds: 1800,
  balance_expire_seconds: 1,
  secret: 'ULaKw6OCW7DNagBssWzcIZr8OEsiI1bukZU8hTHNvulxH5umtAZu2ypT7Ir0qzUUUdPbMfzictFVbAyOxYP8sJuDoyQLBoKadeNx',
  callbackHost: 'http://localhost:8989',
  billUrl: '/bill',
  billProcessUrl: '/bill/process',
  enableUpdateDescribeGraph: false,
  postRateLimit: 100,
  rateLimit: 200,
  forwardReserveFee: 0.01, // default 0.01
  intraHubFee: 0.001, // default 0.003
  redis: {
    port: 6379,
    host: '127.0.0.1',
    family: 4,
    db: 0,
  },
  lnd: {
    url: '127.0.0.1:10009',
  },
};

if (process.env.CONFIG) {
  console.log('using config from env');
  config = JSON.parse(process.env.CONFIG);
}

module.exports = config;
