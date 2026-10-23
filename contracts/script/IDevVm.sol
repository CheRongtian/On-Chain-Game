// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

interface IDevVm {
    function getBlockTimestamp() external view returns (uint256);
    function prank(address caller) external;
    function warp(uint256 timestamp) external;
}
