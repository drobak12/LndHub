let http = require('http');
let config = require('../../config');

export class Exchange
{

    constructor(){
    }

    async swapSatsToUSDC(stats){
      return stats / 4000;
    }

    async swapUSDCToSats(usdc){
      return usdc * 4000;
    }

}