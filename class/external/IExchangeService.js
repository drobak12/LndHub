export class IExchangeService {
  constructor() {
    if (!this.createAccount) {
      throw new Error('Exchange service must implement Create Account!');
    }

    if (!this.loadStableCoin) {
      throw new Error('Exchange service must implement Load Stable Coins!');
    }

    if (!this.unloadStableCoin) {
      throw new Error('Exchange service must implement Unload Stable Coins!');
    }
  }
}
