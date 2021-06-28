require("dotenv").config();
const { ethers } = require("ethers");
const { ParaSwap } = require("paraswap");
const { TenderlyFork } = require("../src/tenderly");
const {
  normalize,
  BigNumber,
  TxBuilderV2,
  distinctContractAddressBetweenMarketsV2,
} = require("@aave/protocol-js");
const { WETH } = require("../src/addresses");

const IERC20_ARTIFACT = require("../artifacts/IERC20.json");
const IWETH_ARTIFACT = require("../artifacts/IWETH.json");
const ILendingPool_ARTIFACT = require("../artifacts/ILendingPool.json");

const FORK_NETWORK_ID = process.env.FORK_NETWORK_ID || "1";
const PARASWAP_API = process.env.PARASWAP_API || "https://apiv4.paraswap.io/v2";

async function main() {
  // Create a new random account signer
  let signer = ethers.Wallet.createRandom();
  console.log("Created wallet for address", signer.address);

  const assets = (
    await (
      await fetch("https://aave.github.io/aave-addresses/mainnet.json")
    ).json()
  ).proto;

  const symbol = "DAI";
  const toAsset = assets.find(
    (asset) => asset.symbol.toUpperCase() === symbol.toUpperCase()
  );

  // Build a swap on ParaSwap
  const amount_to_swap = ethers.utils.parseEther("10.01");
  const paraswap = new ParaSwap(parseInt(FORK_NETWORK_ID), PARASWAP_API);
  const priceRoute = await paraswap.getRate(
    "WETH",
    toAsset.symbol,
    amount_to_swap.toString(),
    "SELL",
    {
      referrer: "aave",
      excludeDEXS: "Balancer",
      excludeContractMethods: ["simpleSwap"],
    }
  );
  const { others, ...priceRouteNoOthers } = priceRoute;
  console.log("priceRoute:", JSON.stringify(priceRouteNoOthers, null, 2));
  if (priceRoute.message) throw new Error("Error getting priceRoute");
  const txParams = await paraswap.buildTx(
    "WETH",
    toAsset.symbol,
    priceRoute.srcAmount,
    priceRoute.priceWithSlippage,
    priceRoute,
    signer.address,
    "aave",
    undefined,
    { ignoreChecks: true },
    18,
    toAsset.decimals
  );
  console.log("txParams:", txParams);
  if (txParams.message) throw new Error("Error getting txParams");

  // Create a fork on Tenderly
  const fork = new TenderlyFork();
  await fork.init();
  console.log("Created fork ID", fork.fork_id);

  // Connect the signer to the fork
  const provider = new ethers.providers.JsonRpcProvider(
    fork.get_rpc_url(),
    parseInt(FORK_NETWORK_ID)
  );
  signer = signer.connect(provider);

  // Fund the account with fake ETH
  await fork.fund_account(signer.address);
  console.log(
    "Balance was set to",
    ethers.utils.formatEther(await signer.getBalance()),
    "ETH"
  );

  // Deposit ETH to get WETH
  console.log("Depositing to WETH...");
  const deposit_amount = ethers.utils.parseEther("10");
  const weth = new ethers.Contract(
    WETH[FORK_NETWORK_ID],
    IWETH_ARTIFACT.abi,
    signer
  );
  await (await weth.deposit({ value: deposit_amount })).wait();
  console.log(
    "Deposited",
    ethers.utils.formatEther(deposit_amount),
    "ETH as WETH"
  );

  // Initialize the txBuilder
  const txBuilder = new TxBuilderV2("mainnet", fork.get_rpc_url());
  const lending_pool_address =
    distinctContractAddressBetweenMarketsV2["proto"]["mainnet"]
      .LENDINGPOOL_ADDRESS;

  // Deposit WETH in Aave AToken
  console.log("Depositing to AToken...");
  const depositTxs = await txBuilder.getLendingPool("proto").deposit({
    reserve: WETH[FORK_NETWORK_ID], // API_ETH_MOCK_ADDRESS
    amount: "10",
    user: signer.address,
  });
  for (const tx of depositTxs) {
    await (await signer.sendTransaction(await tx.tx())).wait();
  }
  const lending_pool = new ethers.Contract(
    lending_pool_address,
    ILendingPool_ARTIFACT.abi,
    signer
  );
  const aWETH_address = (
    await lending_pool.getReserveData(WETH[FORK_NETWORK_ID])
  ).aTokenAddress;
  const aWETH = new ethers.Contract(aWETH_address, IERC20_ARTIFACT.abi, signer);
  const aWETH_balance_before = await aWETH.balanceOf(signer.address);
  console.log(
    "Successfully deposited",
    ethers.utils.formatEther(aWETH_balance_before),
    "WETH in AToken"
  );

  const maxSlippage = 10;
  console.log(priceRoute.priceWithSlippage);

  // Perform the swap on the adapter
  console.log("Performing swap using swapAndDeposit...");
  const swapTxs = await txBuilder.getLendingPool("proto").swapCollateral({
    fromAsset: WETH[FORK_NETWORK_ID],
    toAsset: toAsset.address,
    swapAll: true,
    fromAToken: aWETH_address,
    fromAmount: ethers.utils.formatUnits(priceRoute.srcAmount, 18),
    minToAmount: normalize(
      new BigNumber(priceRoute.priceWithSlippage)
        .multipliedBy((100 - maxSlippage) / 100)
        .toString(),
      toAsset.decimals
    ),
    user: signer.address,
    flash: false,
    augustus: txParams.to,
    swapCallData: txParams.data,
  });
  for (const tx of swapTxs) {
    await (await signer.sendTransaction(await tx.tx())).wait();
  }
  console.log("Swap performed successfully!");
  const aTO_address = (await lending_pool.getReserveData(toAsset.address))
    .aTokenAddress;
  const aTO = new ethers.Contract(aTO_address, IERC20_ARTIFACT.abi, signer);
  const aTO_balance_after = await aTO.balanceOf(signer.address);
  const aWETH_balance_after = await aWETH.balanceOf(signer.address);
  console.log(
    "Final balances",
    ethers.utils.formatEther(aWETH_balance_after),
    "aWETH",
    ethers.utils.formatUnits(aTO_balance_after, toAsset.decimals),
    `a${toAsset.symbol}`
  );
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
