import { Usage } from "../ts/interfaces";
import { deployAll } from "../ts/deploy";
import { TESTING_PARAMS } from "../ts/constants";
import { ethers } from "@nomiclabs/buidler";
import { StateTree } from "../ts/state_tree";
import { AccountRegistry } from "../ts/account_tree";
import { Account } from "../ts/state_account";
import { TxMassMig } from "../ts/tx";
import * as mcl from "../ts/mcl";
import { Tree, Hasher } from "../ts/tree";
import { allContracts } from "../ts/all-contracts-interfaces";
import { assert } from "chai";
import { parseEvents } from "../ts/utils";
describe("Rollup", async function() {
    let Alice: Account;
    let Bob: Account;
    let contracts: allContracts;
    let stateTree: StateTree;
    let registry: AccountRegistry;
    before(async function() {
        await mcl.init();
    });

    beforeEach(async function() {
        const accounts = await ethers.getSigners();
        contracts = await deployAll(accounts[0], TESTING_PARAMS);
        stateTree = new StateTree(TESTING_PARAMS.MAX_DEPTH);
        const registryContract = contracts.blsAccountRegistry;
        registry = await AccountRegistry.new(registryContract);
        const appID =
            "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
        const tokenID = 1;

        Alice = Account.new(appID, -1, tokenID, 10, 0);
        Alice.setStateID(2);
        Alice.newKeyPair();
        Alice.accountID = await registry.register(Alice.encodePubkey());

        Bob = Account.new(appID, -1, tokenID, 10, 0);
        Bob.setStateID(3);
        Bob.newKeyPair();
        Bob.accountID = await registry.register(Bob.encodePubkey());

        stateTree.createAccount(Alice);
        stateTree.createAccount(Bob);
    });

    it("submit a batch and dispute", async function() {
        const tx = new TxMassMig(Alice.stateID, 0, 5, 1, 1, Alice.nonce + 1);
        const signature = Alice.sign(tx);
        const rollup = contracts.rollup;
        const rollupUtils = contracts.rollupUtils;
        var stateRoot = stateTree.root;
        const proof = stateTree.applyMassMigration(tx);
        // stateRoot = stateTree.root;
        const txs = ethers.utils.arrayify(tx.encode(true));
        console.log("transaction", txs);
        const aggregatedSignature0 = mcl.g1ToHex(signature);
        const root = await registry.root();
        const MMInfo = {
            targetSpokeID: tx.spokeID,
            withdrawRoot:
                "0x0000000000000000000000000000000000000000000000000000000000000000",
            tokenID: 1,
            amount: tx.amount
        };

        const commitment = {
            stateRoot,
            accountRoot: root,
            txHashCommitment: ethers.utils.solidityKeccak256(["bytes"], [txs]),
            massMigrationMetaInfo: MMInfo,
            signature: aggregatedSignature0,
            batchType: Usage.MassMigration
        };
        var result = await contracts.rollupReddit.processMMBatch(
            commitment,
            txs,
            [
                {
                    pathToAccount: Alice.stateID,
                    account: proof.account,
                    siblings: proof.witness
                }
            ]
        );

        await rollup.submitBatchWithMM(
            [txs],
            [stateRoot],
            [aggregatedSignature0],
            [MMInfo],
            { value: ethers.utils.parseEther(TESTING_PARAMS.STAKE_AMOUNT) }
        );

        const batchId = Number(await rollup.numOfBatchesSubmitted()) - 1;
        const rootOnchain = await registry.registry.root();
        assert.equal(root, rootOnchain, "mismatch pubkey tree root");
        const batch = await rollup.getBatch(batchId);
        const depth = 1; // Math.log2(commitmentLength + 1)
        const tree = Tree.new(
            depth,
            Hasher.new(
                "bytes",
                ethers.utils.keccak256(
                    "0x0000000000000000000000000000000000000000000000000000000000000000"
                )
            )
        );

        const leaf = await rollupUtils.MMCommitmentToHash(
            commitment.stateRoot,
            commitment.accountRoot,
            commitment.txHashCommitment,
            commitment.massMigrationMetaInfo.tokenID,
            commitment.massMigrationMetaInfo.amount,
            commitment.massMigrationMetaInfo.withdrawRoot,
            commitment.massMigrationMetaInfo.targetSpokeID,
            commitment.signature
        );

        const abiCoder = ethers.utils.defaultAbiCoder;
        const hash = ethers.utils.keccak256(
            abiCoder.encode(
                [
                    "bytes32",
                    "bytes32",
                    "bytes32",
                    "uint256",
                    "uint256",
                    "bytes32",
                    "uint256",
                    "uint256[2]",
                    "uint8"
                ],
                [
                    commitment.stateRoot,
                    commitment.accountRoot,
                    commitment.txHashCommitment,
                    commitment.massMigrationMetaInfo.tokenID,
                    commitment.massMigrationMetaInfo.amount,
                    commitment.massMigrationMetaInfo.withdrawRoot,
                    commitment.massMigrationMetaInfo.targetSpokeID,
                    commitment.signature,
                    commitment.batchType
                ]
            )
        );
        assert.equal(hash, leaf, "mismatch commitment hash");
        tree.updateSingle(0, leaf);
        assert.equal(
            batch.commitmentRoot,
            tree.root,
            "mismatch commitment tree root"
        );

        const commitmentMP = {
            commitment,
            pathToCommitment: 0,
            siblings: tree.witness(0).nodes
        };

        await rollup.disputeMMBatch(batchId, commitmentMP, txs, [
            {
                pathToAccount: Alice.stateID,
                account: proof.account,
                siblings: proof.witness
            }
        ]);
    });
});
