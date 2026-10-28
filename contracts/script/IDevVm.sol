// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

interface IDevVm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function getBlockTimestamp() external view returns (uint256);
    function load(address target, bytes32 slot) external view returns (bytes32);
    function recordLogs() external;
    function getRecordedLogs() external view returns (Log[] memory);
    function readFile(string calldata path) external view returns (string memory);
    function readFileBinary(string calldata path) external view returns (bytes memory);
    function writeFile(string calldata path, string calldata data) external;
    function toString(uint256 value) external pure returns (string memory);
    function toString(bytes32 value) external pure returns (string memory);
    function toString(bytes calldata value) external pure returns (string memory);
    function parseJsonType(string calldata json, string calldata typeDescription)
        external
        pure
        returns (bytes memory);
    function prank(address caller) external;
    function warp(uint256 timestamp) external;
}
