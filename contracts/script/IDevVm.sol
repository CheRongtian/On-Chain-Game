// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

interface IDevVm {
    function getBlockTimestamp() external view returns (uint256);
    function readFile(string calldata path) external view returns (string memory);
    function parseJsonType(string calldata json, string calldata typeDescription)
        external
        pure
        returns (bytes memory);
    function prank(address caller) external;
    function warp(uint256 timestamp) external;
}
