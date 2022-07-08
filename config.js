const bitcoin = require('bitcoinjs-lib')
let config = {
  network: bitcoin.networks.testnet,
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
  wallet: {
    companyId: 5323,
    hostname: '127.0.0.1',
    port: 8081,
    createAccountUrl: '/wallet',
    balanceUrl: '/wallet/{walletId}/available_balance',
    transactionUrl: '/wallet/{walletId}/transactions'
  },  
  redis: {
    port: 6379,
    host: '127.0.0.1',
    family: 4,
    db: 0,
  },
  lnd: {
    url: '127.0.0.1:10009',
  },
  currencyConvert:{
    url: 'https://free.currconv.com/api/v7/convert?apiKey=40b360058919ec2bc32e&compact=ultra&q=BTC_',
    updateIntervalMillis :1200000,
    currencies: ['USD', 'EUR', 'BRL', 'JPY', 'UYU']
  }
};

if (process.env.CONFIG) {
  console.log('using config from env');
  config = JSON.parse(process.env.CONFIG);
}

module.exports = config;
