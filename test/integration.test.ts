import { assert } from "chai";
import { Signer } from "ethers";
import { ethers } from "hardhat";
import { AccountRegistry } from "../ts/accountTree";
import { allContracts } from "../ts/allContractsInterfaces";
import { PRODUCTION_PARAMS } from "../ts/constants";
import { deployAll } from "../ts/deploy";
import { UserStateFactory } from "../ts/factory";
import { DeploymentParameters } from "../ts/interfaces";
import { StateTree } from "../ts/stateTree";
import { TestTokenFactory } from "../types/ethers-contracts";
import { BurnAuction } from "../types/ethers-contracts/BurnAuction";
import * as mcl from "../ts/mcl";
import { TestToken } from "../types/ethers-contracts/TestToken";

const DOMAIN =
    "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

describe("Integration Test", function() {
    let contracts: allContracts;
    let stateTree: StateTree;
    let parameters: DeploymentParameters;
    let deployer: Signer;
    let coordinator: Signer;
    let accountRegistry: AccountRegistry;
    let newToken: TestToken;

    before(async function() {
        await mcl.init();
        mcl.setDomainHex(DOMAIN);
        [deployer, coordinator] = await ethers.getSigners();
        parameters = PRODUCTION_PARAMS;
        stateTree = StateTree.new(parameters.MAX_DEPTH);
        parameters.GENESIS_STATE_ROOT = stateTree.root;
        contracts = await deployAll(deployer, parameters);

        accountRegistry = await AccountRegistry.new(
            contracts.blsAccountRegistry
        );
    });
    it("Register another token", async function() {
        const { tokenRegistry } = contracts;
        newToken = await new TestTokenFactory(coordinator).deploy();
        await tokenRegistry.requestRegistration(newToken.address);
        const tx = await tokenRegistry.finaliseRegistration(newToken.address);
        const [event] = await tokenRegistry.queryFilter(
            tokenRegistry.filters.RegisteredToken(null, null),
            tx.blockHash
        );
        // In the deploy script, we already have a TestToken registered with tokenID 1
        assert.equal(event.args?.tokenType, 2);
    });
    it("Coordinator bid the first auction", async function() {
        const chooser = contracts.chooser as BurnAuction;
        await chooser.connect(coordinator).bid({ value: "1" });
    });
    it("Deposit some users", async function() {
        const { depositManager } = contracts;
        const subtreeSize = 1 << parameters.MAX_DEPOSIT_SUBTREE_DEPTH;
        const nSubtrees = 5;
        const nDeposits = nSubtrees * subtreeSize;
        const states = UserStateFactory.buildList({
            numOfStates: nDeposits,
            initialStateID: 0,
            initialAccID: 0,
            tokenID: 2,
            zeroNonce: true
        });

        const fromBlockNumber = await deployer.provider?.getBlockNumber();
        for (const state of states) {
            const pubkeyID = await accountRegistry.register(state.getPubkey());
            assert.equal(pubkeyID, state.pubkeyIndex);
            await newToken
                .connect(coordinator)
                .approve(depositManager.address, state.balance);
            await depositManager
                .connect(coordinator)
                .depositFor(state.pubkeyIndex, state.balance, state.tokenType);
        }

        const subtreeReadyEvents = await depositManager.queryFilter(
            depositManager.filters.DepositSubTreeReady(null),
            fromBlockNumber
        );
        assert.equal(subtreeReadyEvents.length, nSubtrees);
    });
    it("Users doing Transfers");
    it("Getting new users via Create to transfer");
    it("Exit via mass migration");
    it("Users withdraw funds");
    it("Coordinator withdrew their stack");
});
