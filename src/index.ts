import { Api, JsonRpc } from "eosjs";
import { SignatureProvider } from "eosjs/dist/eosjs-api-interfaces";
import { IWhitelistedContract } from "./IWhitelistedContract";
import { WaxEventSource } from "./WaxEventSource";

export class WaxJS {
  public api: Api;
  private waxEventSource: WaxEventSource;
  private readonly rpc: JsonRpc;
  private userAccount: string;
  private pubKeys: string[];
  private signingWindow: Window;
  private whitelistedContracts: IWhitelistedContract[];
  private apiSigner: SignatureProvider;
  private waxSigningURL: string;
  private waxAutoSigningURL: string;

  constructor({
    rpcEndpoint,
    tryAutoLogin = true,
    userAccount,
    pubKeys,
    apiSigner,
    waxSigningURL = "https://all-access.wax.io",
    waxAutoSigningURL = "https://api-idm.wax.io/v1/accounts/auto-accept/"
  }: {
    rpcEndpoint: string;
    userAccount?: string;
    pubKeys?: string[];
    tryAutoLogin: boolean;
    apiSigner?: SignatureProvider;
    waxSigningURL: string;
    waxAutoSigningURL: string;
  }) {
    this.waxEventSource = new WaxEventSource(waxSigningURL);
    this.rpc = new JsonRpc(rpcEndpoint);
    this.waxSigningURL = waxSigningURL;
    this.waxAutoSigningURL = waxAutoSigningURL;
    this.apiSigner = apiSigner;

    if (userAccount && Array.isArray(pubKeys)) {
      // login from constructor
      const data = { userAccount, pubKeys, verified: true };
      this.receiveLogin({ data });
    } else {
      // try to auto-login via endpoint
      if (tryAutoLogin) {
        this.loginViaEndpoint();
      }
    }
  }

  public async login() {
    if (this.userAccount && Array.isArray(this.pubKeys)) {
      return this.userAccount;
    } else {
      // login via UI
      return this.loginViaWindow();
    }
  }

  public async isAutoLoginAvailable() {
    if (this.userAccount && Array.isArray(this.pubKeys)) {
      return true;
    } else {
      // try to auto-login via endpoint
      try {
        await this.loginViaEndpoint();
        return true;
      } catch (e) {
        return false;
      }
    }
  }

  private async loginViaWindow() {
    const confirmationWindow = await this.waxEventSource.openEventSource(
      this.waxSigningURL + "/cloud-wallet/login/"
    );

    return this.waxEventSource.onceEvent(
      confirmationWindow,
      this.waxSigningURL,
      this.receiveLogin.bind(this)
    );
  }

  private async loginViaEndpoint() {
    const response = await fetch(this.waxAutoSigningURL + "login", {
      credentials: "include",
      method: "get"
    });
    if (!response.ok) {
      throw new Error(
        `Login Endpoint Error ${response.status} ${response.statusText}`
      );
    }
    const data = await response.json();
    if (data.processed && data.processed.except) {
      throw new Error(data);
    }
    return this.receiveLogin({ data });
  }

  private async receiveLogin(event: any) {
    const {
      verified,
      userAccount,
      pubKeys,
      whitelistedContracts,
      autoLogin
    } = event.data;
    if (!verified) {
      throw new Error("User declined to share their user account");
    }

    if (userAccount == null || pubKeys == null) {
      throw new Error("User does not have a blockchain account");
    }

    localStorage.setItem("autoLogin", autoLogin);
    this.whitelistedContracts = whitelistedContracts || [];
    this.userAccount = userAccount;
    this.pubKeys = pubKeys;

    const signatureProvider = {
      getAvailableKeys: async () => {
        return [
          ...this.pubKeys,
          ...((this.apiSigner && (await this.apiSigner.getAvailableKeys())) ||
            [])
        ];
      },
      sign: async (data: any) => {
        const {
          serializedTransaction,
          signatures
        }: {
          serializedTransaction: any;
          signatures: string[];
        } = await this.signing({
          transaction: data.serializedTransaction,
          waxPaysBW: !this.apiSigner
        });
        // TODO: eliminate this mutation. Check what else is on this data abject that would also need mutation
        // TODO: allow for a verification callback to permit dapp creators an opportunity to validate the serialized tx received from wax-on
        data.serializedTransaction = serializedTransaction;
        return {
          serializedTransaction,
          signatures: [
            ...signatures,
            ...((this.apiSigner &&
              (await this.apiSigner.sign(data)).signatures) ||
              [])
          ]
        };
      }
    };
    // @ts-ignore
    this.api = new Api({
      rpc: this.rpc,
      signatureProvider
    });
    const transact = this.api.transact.bind(this.api);
    const url = this.waxSigningURL + "/cloud-wallet/signing/";
    // We monkeypatch the transact method to overcome timeouts
    // firing the pop-up which some browsers enforce, such as Safari.
    // By pre-creating the pop-up window we will interact with,
    // we ensure that it is not going to be rejected due to a delayed
    // pop up that would otherwise occur post transaction creation
    this.api.transact = async (transaction, namedParams) => {
      if (!(await this.canAutoSign(transaction))) {
        this.signingWindow = await window.open(
          url,
          "WaxPopup",
          "height=800,width=600"
        );
      }
      return await transact(transaction, namedParams);
    };

    return this.userAccount;
  }

  private async canAutoSign(transaction: any) {
    const deserializedTransaction = transaction.actions
      ? transaction
      : await this.api.deserializeTransactionWithActions(transaction);
    return !deserializedTransaction.actions.find((action: any) => {
      return !this.isWhitelisted(action);
    });
  }

  private isWhitelisted(action: any) {
    return !!this.whitelistedContracts.find((w: any) => {
      if (w.contract === action.account) {
        if (action.account === "eosio.token" && action.name === "transfer") {
          return w.recipients.includes(action.data.to);
        }
        return true;
      }
      return false;
    });
  }

  private async signing(txArgs: any): Promise<any> {
    if (await this.canAutoSign(txArgs.transaction)) {
      return this.signViaEndpoint(txArgs).catch(() =>
        // Attempt to recover by signing via the window method
        this.signViaWindow(undefined, txArgs)
      );
    }

    return this.signViaWindow(this.signingWindow, txArgs);
  }

  private async signViaEndpoint({
    transaction,
    waxPaysBW
  }: {
    transaction: any;
    waxPaysBW: boolean;
  }) {
    try {
      const response: any = await fetch(this.waxAutoSigningURL + "signing", {
        body: JSON.stringify({
          transaction: Object.values(transaction),
          waxPaysBW
        }),
        credentials: "include",
        headers: {
          "Content-Type": "application/json"
        },
        method: "POST"
      });
      if (!response.ok) {
        throw new Error(
          `Signing Endpoint Error ${response.status} ${response.statusText}`
        );
      }
      const data: any = await response.json();
      if (data.processed && data.processed.except) {
        throw new Error(data);
      }
      return this.receiveSignatures({ data });
    } catch (e) {
      // clear the whitelist to make sure we don't repeatedly attempt blocked actions
      this.whitelistedContracts = [];
      throw e;
    }
  }

  private async signViaWindow(
    window: Window,
    { transaction, waxPaysBW }: { transaction: any; waxPaysBW: boolean }
  ) {
    const confirmationWindow: Window = await this.waxEventSource.openEventSource(
      this.waxSigningURL + "/cloud-wallet/signing/",
      { type: "TRANSACTION", transaction, waxPaysBW },
      window
    );

    return this.waxEventSource.onceEvent(
      confirmationWindow,
      this.waxSigningURL,
      this.receiveSignatures.bind(this)
    );
  }

  private async receiveSignatures(event: any): Promise<any> {
    if (event.data.type === "TX_SIGNED") {
      let {
        verified,
        signatures,
        serializedTransaction,
        whitelistedContracts
      } = event.data;
      if (!verified || signatures == null) {
        throw new Error("User declined to sign the transaction");
      }
      this.whitelistedContracts = whitelistedContracts || [];

      return {
        signatures,
        serializedTransaction: Uint8Array.from(serializedTransaction)
      };
    } else if (event.data.type !== "READY") {
      throw new Error(
        `Unexpected response received when attempting signing: ${JSON.stringify(
          event.data,
          undefined,
          2
        )}`
      );
    }
    return [];
  }
}
