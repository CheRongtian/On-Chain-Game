// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { IDevVm } from "../script/IDevVm.sol";
import { SquadRuleHandler } from "./SquadRuleHandler.sol";
import { SquadSafetySupport as Support } from "./SquadSafetySupport.sol";

// Reproducible bounded sequences deliberately call the same disposable handler.
// forge-lint: disable-start(literal-instead-of-constant,calls-loop,require-revert-in-loop)
contract SquadRuleInvariantTest {
    IDevVm private constant VM = IDevVm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    struct FuzzSelector {
        address addr;
        bytes4[] selectors;
    }

    struct FuzzArtifactSelector {
        string artifact;
        bytes4[] selectors;
    }

    struct FuzzInterface {
        address addr;
        string[] artifacts;
    }
    SquadRuleHandler private handler;

    function setUp() public {
        handler = new SquadRuleHandler();
    }

    function targetContracts() external view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function targetSelectors() external view returns (FuzzSelector[] memory targets) {
        targets = new FuzzSelector[](1);
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = SquadRuleHandler.step.selector;
        targets[0] = FuzzSelector({ addr: address(handler), selectors: selectors });
    }

    // Empty optional discovery hooks follow Foundry's standard invariant interface.
    function targetArtifacts() external pure returns (string[] memory) {
        return new string[](0);
    }

    function excludeArtifacts() external pure returns (string[] memory) {
        return new string[](0);
    }

    function targetArtifactSelectors() external pure returns (FuzzArtifactSelector[] memory) {
        return new FuzzArtifactSelector[](0);
    }

    function targetInterfaces() external pure returns (FuzzInterface[] memory) {
        return new FuzzInterface[](0);
    }

    function targetSenders() external pure returns (address[] memory) {
        return new address[](0);
    }

    function excludeSenders() external pure returns (address[] memory) {
        return new address[](0);
    }

    function excludeContracts() external pure returns (address[] memory) {
        return new address[](0);
    }

    function excludeSelectors() external pure returns (FuzzSelector[] memory) {
        return new FuzzSelector[](0);
    }

    function invariantCanonicalStateResourcesAndHash() public view {
        handler.check();
    }

    function testContinuousSequenceCoverage() public {
        uint256 seed = 20261109;
        for (uint256 index = 0; index < 128; ++index) {
            seed = Support.nextSeed(seed);
            handler.step(seed);
            handler.check();
        }
        require(
            handler.steps() == 128 && handler.settlements() > 2 && handler.games() > 1
                && handler.terminals() > 1 && handler.rejections() > 1,
            "Random sequence did not advance games"
        );
        string memory row = string.concat(
            '{"status":"passed","steps":',
            VM.toString(handler.steps()),
            ',"games":',
            VM.toString(handler.games()),
            ',"settlements":',
            VM.toString(handler.settlements())
        );
        row = string.concat(
            row,
            ',"moves":',
            VM.toString(handler.moves()),
            ',"healing":',
            VM.toString(handler.healing()),
            ',"damage":',
            VM.toString(handler.damage())
        );
        row = string.concat(
            row,
            ',"locks":',
            VM.toString(handler.locks()),
            ',"deaths":',
            VM.toString(handler.deaths()),
            ',"terminals":',
            VM.toString(handler.terminals()),
            ',"rejections":',
            VM.toString(handler.rejections()),
            "}"
        );
        // Existing safety-directory permissions contain all generated coverage evidence.
        // forge-lint: disable-next-line(unsafe-cheatcode)
        VM.writeFile("../.local/safety/squad-coverage.json", row);
    }
}
// forge-lint: disable-end(literal-instead-of-constant,calls-loop,require-revert-in-loop)
