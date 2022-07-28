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
  postRateLimit: 800,
  rateLimit: 1000,
  forwardReserveFee: 0.01, // default 0.01
  intraHubFee: 0.001, // default 0.003
  wallet: {
    companyId: 5323,
    hostname: '127.0.0.1',
    port: 8081,
    createAccountUrl: '/wallet',
    balanceUrl: '/wallet/{walletId}/available_balance',
    transactionUrl: '/wallet/{walletId}/transactions',
    masterAccount: 'GLOBANT',
    masterAccountCurrency: 'USDC'
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
    urlCurrencyToBtc: 'https://free.currconv.com/api/v7/convert?apiKey=40b360058919ec2bc32e&compact=ultra&q={currency}_BTC',
    updateIntervalMillis :1200000,
    currencies: ['USD', 'EUR', 'BRL', 'JPY', 'UYU']
  },
  swap:{
    min_swap_value: 25,
    min_swap_currency: 'USD',
    balanceUpperLimitUSDC: 100
  },
  exchangeMs: {
    mockEnable: false,
    protocol: 'https',
    hostname: 'sandbox-b2b.ripio.com',
    port: 443,
    grantType: 'client_credentials',
    clientId: 'ynPaww60Yzb3ib16Mu4rnUS71Mw1Sx7wbWswOUfi',
    clientSecret: 'N8KBd1gYViHnW0vNQ4j9TKIN4H1tqaX88meIm1h9ZCULE49q9PNLC63uu2OuRLMyyHzkKxRhmdIDlXIHhc1cAit2pDaoLj1MyGp2xaggPWWhaEbTDUOmpOX0tNm47ke0',
    userId: 'WHATSAPP.573016347804',
    createAccountUrl: '/api/v1/end-users/',
    authenticationUrl: '/oauth2/token/',
    balanceUrl: '/api/v1/end-users/{user-id}/balances/',
    swapQuoteUrl: '/api/v1/swap-quotes/',
    swapQuoteExecutionUrl: '/api/v1/swap-quotes/{swap_quote_id}/actions/execute/',
    loadBalanceUrl: '/api/v1/end-users/{user-id}/load/',
    withdrawUrl: '/api/v1/withdrawals/'
  },
  billExpiration: 86400
};

if (process.env.CONFIG) {
  console.log('using config from env');
  config = JSON.parse(process.env.CONFIG);
}

module.exports = config;
