// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title MinimalERC20
 * @notice A minimal, OpenZeppelin-free ERC-20 used by the
 * GhostBroker integration tests and the local Anvil
 * deployment. Exposes only the methods the relayer needs
 * (`transferFrom`, `balanceOf`) plus `mint` and `approve`
 * for the test harness.
 *
 * NOT intended for production. Production uses audited
 * OpenZeppelin ERC-20 contracts on Sepolia. This file ships
 * with the integration-test fixture so the test does not
 * require a Solidity compiler at test time (the test
 * deploys the bytecode from
 * `out/MinimalERC20.sol/MinimalERC20.json`).
 */
contract MinimalERC20 {
    string public name;
    string public symbol;
    uint8 public immutable decimals;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    constructor(
        string memory _name,
        string memory _symbol,
        uint8 _decimals
    ) {
        name = _name;
        symbol = _symbol;
        decimals = _decimals;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
