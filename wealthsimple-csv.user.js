// ==UserScript==
// @name        Wealthsimple Download CSV
// @namespace   Violentmonkey Scripts
// @match       https://my.wealthsimple.com/*
// @grant       none
// @version     1.0
// @license     MIT
// @author      eaglesemanation
// @description Adds download CSV button to activity feed.
// ==/UserScript==

const button = document.createElement("button");
button.append("Download CSV");
button.addEventListener("click", () => onClick());
new MutationObserver(() => onMutation()).observe(document.documentElement, {
  childList: true,
  subtree: true,
});

/** @typedef {FetchActivityFeedItemsQuery["activityFeedItems"]} Activities */
/** @typedef {Activities["edges"][number]["node"]} Activity */

async function onClick() {
  const cookieValue = /** @type {never} */ (
    getCookieValue("_oauth2_access_v2")
  );
  const { access_token, identity_canonical_id } =
    /** @type {{ access_token: string; identity_canonical_id: string }} */
    (JSON.parse(decodeURIComponent(cookieValue)));
  const accounts = await getAccounts();
  const searchParams = new URLSearchParams(location.search);
  const accountIds =
    searchParams.get("account_ids")?.split(",") ?? Object.keys(accounts);
  saveBlob(await getBlob(), getFilename());

  /** @typedef {FetchAllAccountFinancialsQuery["identity"]["accounts"]} Accounts */
  /**
   * @typedef {Object} Account
   * @property {string} nickname
   * @property {[string, ...string[]]} custodianAccountIds
   */

  async function getAccounts() {
    /** @type {Record<string, Account>} */
    const byId = {};
    /** @type {Accounts["pageInfo"]} */
    let pageInfo = {};
    do {
      const { data } = await useQuery(fetchAllAccountFinancialsQuery, {
        pageSize: 25,
        identityId: identity_canonical_id,
        cursor: pageInfo.endCursor,
      });
      const accounts = data.identity.accounts;
      for (const { node: account } of accounts.edges) {
        byId[account.id] = {
          nickname:
            account.nickname ||
            nicknames[/** @type {never} */ (account.unifiedAccountType)],
          custodianAccountIds: /** @type {never} */ (
            account.custodianAccounts.map(
              (custodianAccount) => custodianAccount.id,
            )
          ),
        };
      }
      pageInfo = accounts.pageInfo;
    } while (pageInfo.hasNextPage);
    return byId;
  }

  async function getBlob() {
    const rows = await Array.fromAsync(getRows());
    rows.sort(
      (a, b) =>
        /** @type {never} */ (
          a[header.Date] === b[header.Date] &&
            a[header.Amount] === -b[header.Amount] &&
            b[header.Amount] - a[header.Amount]
        ),
    );
    rows.sort(
      (a, b) =>
        /** @type {never} */ (
          a[header["Transaction ID"]] === b[header["Transaction ID"]] &&
            b[header.Amount] - a[header.Amount]
        ),
    );
    return new Blob(
      [Object.keys(header), ...rows].map((row) => `${row.join(",")}\n`),
      { type: "text/csv" },
    );
  }

  async function* getRows() {
    const startDate = new Date();
    startDate.setDate(
      startDate.getDate() -
        days[/** @type {never} */ (searchParams.get("timeframe"))],
    );
    /** @type {Activities["pageInfo"]} */
    let pageInfo = {};
    do {
      const { data } = await useQuery(fetchActivityFeedItemsQuery, {
        orderBy: "OCCURRED_AT_DESC",
        condition: /** @type {never} */ ({ accountIds, startDate }),
        first: 50,
        cursor: pageInfo.endCursor,
      });
      const activities = data.activityFeedItems;
      const fundsTransfers = await getFundsTransfers(activities);
      const spendTransactions = await getSpendTransactions(activities);
      for (const { node: activity } of activities.edges) {
        // Ignore ones with neither asset quantity nor cash amount
        switch ([activity.type, activity.subType].join("/")) {
          case "INSTITUTIONAL_TRANSFER_INTENT/TRANSFER_IN":
            continue;
        }
        const account = /** @type {Account} */ (
          accounts[/** @type {never} */ (activity.accountId)]
        );
        const [accountNumber] = account.custodianAccountIds;
        // Print asset quantity
        switch ([activity.type, activity.subType].join("/")) {
          case "LEGACY_TRANSFER/TRANSFER_IN":
          case "MANAGED_BUY/":
          case "MANAGED_SELL/":
          case "STOCK_DIVIDEND/":
            yield /** @type {const} */ ([
              activity.occurredAt,
              getDescription(activity),
              activity.spendMerchant,
              activity.aftTransactionCategory,
              getAssetQuantity(activity),
              activity.assetSymbol,
              account.nickname,
              accountNumber,
              "Wealthsimple",
              activity.canonicalId,
            ]);
            break;
        }
        // Finished ones with asset quantity only and no cash amount
        switch ([activity.type, activity.subType].join("/")) {
          case "LEGACY_TRANSFER/TRANSFER_IN":
          case "STOCK_DIVIDEND/":
            continue;
        }
        // Print cash amount
        yield /** @type {const} */ ([
          activity.occurredAt,
          getDescription(activity),
          activity.spendMerchant,
          activity.aftTransactionCategory,
          getAmount(activity),
          ,
          account.nickname,
          accountNumber,
          "Wealthsimple",
          activity.canonicalId,
        ]);
        // Print spend rewards
        const spendTransaction =
          spendTransactions[/** @type {never} */ (activity.accountId)]?.[
            /** @type {never} */ (activity.externalCanonicalId)
          ];
        if (!spendTransaction?.hasReward) {
          continue;
        }
        const payoutAccount = /** @type {Account} */ (
          Object.values(accounts).find((account) =>
            account.custodianAccountIds.includes(
              /** @type {never} */ (
                spendTransaction.rewardPayoutCustodianAccountId
              ),
            ),
          )
        );
        const [payoutAccountNumber] = payoutAccount.custodianAccountIds;
        yield /** @type {const} */ ([
          activity.occurredAt,
          "Spend rewards",
          ,
          ,
          /** @type {never} */ (spendTransaction.rewardAmount) / 100,
          ,
          payoutAccount.nickname,
          payoutAccountNumber,
          "Wealthsimple",
          activity.canonicalId,
        ]);
      }
      pageInfo = activities.pageInfo;

      /** @typedef {FetchFundsTransferQuery["fundsTransfer"]} FundsTransfer */

      /** @param {Activity} activity */
      function getDescription(activity) {
        switch ([activity.type, activity.subType].join("/")) {
          case "DEPOSIT/AFT":
            return `Direct deposit from ${activity.aftOriginatorName}`;
          case "DEPOSIT/EFT":
            return `Electronic funds transfer from ${
              /** @type {FundsTransfer} */ (
                fundsTransfers[
                  /** @type {never} */ (activity.externalCanonicalId)
                ]
              ).source.bankAccount.institutionName
            }`;
          case "DIVIDEND/":
            return `Dividend from ${activity.assetSymbol}`;
          case "FEE/MANAGEMENT_FEE":
            return "Management fee";
          case "INTEREST/":
            return "Interest";
          case "INTERNAL_TRANSFER/DESTINATION":
            return `Transfer from ${/** @type {Account} */ (accounts[/** @type {never} */ (activity.opposingAccountId)]).nickname}`;
          case "INTERNAL_TRANSFER/SOURCE":
            return `Transfer to ${/** @type {Account} */ (accounts[/** @type {never} */ (activity.opposingAccountId)]).nickname}`;
          case "LEGACY_TRANSFER/TRANSFER_IN":
            return "Institutional transfer";
          case "MANAGED_BUY/":
            return `Invested cash in ${activity.assetSymbol}`;
          case "MANAGED_SELL/":
            return `Sold asset of ${activity.assetSymbol}`;
          case "PROMOTION/INCENTIVE_BONUS":
            return "Promotional bonus";
          case "REFERRAL/":
            return "Referral bonus";
          case "REFUND/TRANSFER_FEE_REFUND":
            return "Transfer fee refund";
          case "REIMBURSEMENT/ACCOUNTING_REIMBURSEMENT":
            return "Accounting reimbursement";
          case "REIMBURSEMENT/ATM":
            return "ATM fee reimbursement";
          case "REIMBURSEMENT/ETF_REBATE":
            return "Exchange-traded funds rebate";
          case "SPEND/PREPAID":
            return activity.spendMerchant;
          case "STOCK_DIVIDEND/":
            return "Stock dividend";
          case "WITHDRAWAL/AFT":
            return `Pre-authorized debit to ${activity.aftOriginatorName}`;
          case "WITHDRAWAL/E_TRANSFER":
            return `INTERAC e-Transfer® to ${activity.eTransferName}`;
          case "WRITE_OFF/":
            return "Write-off";
        }
      }
    } while (pageInfo.hasNextPage);
  }

  /** @param {Activities} activities */
  async function getFundsTransfers(activities) {
    const ids = [];
    for (const { node: activity } of activities.edges) {
      switch ([activity.type, activity.subType].join("/")) {
        case "DEPOSIT/EFT":
          ids.push(/** @type {string} */ (activity.externalCanonicalId));
          break;
      }
    }
    return Object.fromEntries(
      await Promise.all(
        ids.map(async (id) => {
          const { data } = await useQuery(fetchFundsTransferQuery, { id });
          return /** @type {const} */ ([id, data.fundsTransfer]);
        }),
      ),
    );
  }

  /** @typedef {FetchSpendTransactionsQuery["spendTransactions"]} SpendTransactions */
  /** @typedef {SpendTransactions["edges"][number]["node"]} SpendTransaction */

  /** @param {Activities} activities */
  async function getSpendTransactions(activities) {
    /** @type {Record<string, string[]>} */
    const ids = {};
    for (const { node: activity } of activities.edges) {
      switch ([activity.type, activity.subType].join("/")) {
        case "SPEND/PREPAID":
          (ids[/** @type {never} */ (activity.accountId)] ??= []).push(
            /** @type {never} */ (activity.externalCanonicalId),
          );
          break;
      }
    }
    return Object.fromEntries(
      await Promise.all(
        Object.entries(ids).map(async ([accountId, transactionIds]) => {
          /** @type {Record<string, SpendTransaction>} */
          const byId = {};
          /** @type {SpendTransactions["pageInfo"]} */
          let pageInfo = {};
          do {
            const { data } = await useQuery(fetchSpendTransactionsQuery, {
              accountId,
              transactionIds,
              cursor: pageInfo.endCursor,
            });
            const spendTransactions = data.spendTransactions;
            for (const { node: spendTransaction } of spendTransactions.edges) {
              byId[spendTransaction.id] = spendTransaction;
            }
            pageInfo = spendTransactions.pageInfo;
          } while (pageInfo.hasNextPage);
          return /** @type {const} */ ([accountId, byId]);
        }),
      ),
    );
  }

  /**
   * @overload
   * @param {typeof fetchAllAccountFinancialsQuery} query
   * @param {FetchAllAccountFinancialsQueryVariables} variables
   * @returns {Promise<{ data: FetchAllAccountFinancialsQuery }>}
   */
  /**
   * @overload
   * @param {typeof fetchActivityFeedItemsQuery} query
   * @param {FetchActivityFeedItemsQueryVariables} variables
   * @returns {Promise<{ data: FetchActivityFeedItemsQuery }>}
   */
  /**
   * @overload
   * @param {typeof fetchFundsTransferQuery} query
   * @param {FetchFundsTransferQueryVariables} variables
   * @returns {Promise<{ data: FetchFundsTransferQuery }>}
   */
  /**
   * @overload
   * @param {typeof fetchSpendTransactionsQuery} query
   * @param {FetchSpendTransactionsQueryVariables} variables
   * @returns {Promise<{ data: FetchSpendTransactionsQuery }>}
   */
  /**
   * @param {unknown} query
   * @param {unknown} variables
   */
  async function useQuery(query, variables) {
    const response = await fetch("/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access_token}`,
        "Content-Type": "application/json",
        "X-Ws-Profile": "invest",
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) {
      throw new Error(`Response status: ${response.status}`);
    }
    return response.json();
  }

  function getFilename() {
    if (accountIds.length === 1) {
      const account = /** @type {Account} */ (
        accounts[/** @type {never} */ (accountIds)]
      );
      const [accountNumber] = account.custodianAccountIds;
      return accountNumber;
    }
    return identity_canonical_id;
  }
}

/** @param {unknown} name */
function getCookieValue(name) {
  for (const cookiePair of document.cookie.split("; ")) {
    const [cookieName, cookieValue] = cookiePair.split("=", 2);
    if (cookieName === name) {
      return cookieValue;
    }
  }
}

const nicknames = {
  CASH: "Cash",
  MANAGED_JOINT: "Joint",
  MANAGED_NON_REGISTERED: "Non-registered",
  MANAGED_RRSP: "RRSP",
  MANAGED_TFSA: "TFSA",
  SELF_DIRECTED_CRYPTO: "Crypto",
  SELF_DIRECTED_NON_REGISTERED: "Non-registered",
};

const days = {
  "last-week": 7,
  "last-30-days": 30,
  "last-60-days": 60,
  "last-90-days": 90,
};

/** @param {Activity} activity */
function getAssetQuantity(activity) {
  switch ([activity.type, activity.subType].join("/")) {
    case "MANAGED_SELL/":
      return -(/** @type {never} */ (activity.assetQuantity));
  }
  return +(/** @type {never} */ (activity.assetQuantity));
}

/** @param {Activity} activity */
function getAmount(activity) {
  switch ([activity.type, activity.subType].join("/")) {
    case "MANAGED_BUY/":
      return -(/** @type {never} */ (activity.amount));
  }
  switch (/** @type {"positive" | "negative"} */ (activity.amountSign)) {
    case "positive":
    case null:
      return +(/** @type {never} */ (activity.amount));
    case "negative":
      return -(/** @type {never} */ (activity.amount));
  }
}

const header = /** @type {{ Date: 0; Amount: 4; "Transaction ID": 9 }} */ (
  Object.fromEntries(
    [
      "Date",
      "Description",
      "Merchant Name",
      "Category Hint",
      "Amount",
      "Symbol",
      "Account",
      "Account #",
      "Institution",
      "Transaction ID",
    ]
      .entries()
      .map(([index, name]) => [name, index]),
  )
);

/**
 * @param {Blob} blob
 * @param {string} filename
 */
function saveBlob(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function onMutation() {
  if (location.pathname === "/app/activity" && !button.isConnected) {
    document
      .querySelector(`div:has(> button svg > path[d="${pathData}"])`)
      ?.before(button);
  }
}

const pathData =
  "M14 8c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1s.4-1 1-1h10c.6 0 1 .4 1 1Zm1-6H1c-.6 0-1 .4-1 1s.4 1 1 1h14c.6 0 1-.4 1-1s-.4-1-1-1Zm-4 10H5c-.6 0-1 .4-1 1s.4 1 1 1h6c.6 0 1-.4 1-1s-.4-1-1-1Z";

const fetchAllAccountFinancialsQuery = /* GraphQL */ `
  query FetchAllAccountFinancials(
    $identityId: ID!
    $startDate: Date
    $pageSize: Int = 25
    $cursor: String
  ) {
    identity(id: $identityId) {
      id
      ...AllAccountFinancials
    }
  }

  fragment AllAccountFinancials on Identity {
    accounts(filter: {}, first: $pageSize, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        cursor
        node {
          ...AccountWithFinancials
        }
      }
    }
  }

  fragment AccountWithFinancials on Account {
    ...AccountWithLink
    ...AccountFinancials
  }

  fragment AccountWithLink on Account {
    ...Account
    linkedAccount {
      ...Account
    }
  }

  fragment Account on Account {
    ...AccountCore
    custodianAccounts {
      ...CustodianAccount
    }
  }

  fragment AccountCore on Account {
    id
    archivedAt
    branch
    closedAt
    createdAt
    cacheExpiredAt
    currency
    requiredIdentityVerification
    unifiedAccountType
    supportedCurrencies
    nickname
    status
    accountOwnerConfiguration
    accountFeatures {
      ...AccountFeature
    }
    accountOwners {
      ...AccountOwner
    }
    type
  }

  fragment AccountFeature on AccountFeature {
    name
    enabled
  }

  fragment AccountOwner on AccountOwner {
    accountId
    identityId
    accountNickname
    clientCanonicalId
    accountOpeningAgreementsSigned
    name
    email
    ownershipType
    activeInvitation {
      ...AccountOwnerInvitation
    }
    sentInvitations {
      ...AccountOwnerInvitation
    }
  }

  fragment AccountOwnerInvitation on AccountOwnerInvitation {
    id
    createdAt
    inviteeName
    inviteeEmail
    inviterName
    inviterEmail
    updatedAt
    sentAt
    status
  }

  fragment CustodianAccount on CustodianAccount {
    id
    branch
    custodian
    status
    updatedAt
  }

  fragment AccountFinancials on Account {
    id
    custodianAccounts {
      id
      financials {
        current {
          ...CustodianAccountCurrentFinancialValues
        }
      }
    }
    financials {
      currentCombined {
        ...AccountCurrentFinancials
      }
    }
  }

  fragment CustodianAccountCurrentFinancialValues on CustodianAccountCurrentFinancialValues {
    deposits {
      ...Money
    }
    earnings {
      ...Money
    }
    netDeposits {
      ...Money
    }
    netLiquidationValue {
      ...Money
    }
    withdrawals {
      ...Money
    }
  }

  fragment Money on Money {
    amount
    cents
    currency
  }

  fragment AccountCurrentFinancials on AccountCurrentFinancials {
    netLiquidationValue {
      ...Money
    }
    netDeposits {
      ...Money
    }
    simpleReturns(referenceDate: $startDate) {
      ...SimpleReturns
    }
    totalDeposits {
      ...Money
    }
    totalWithdrawals {
      ...Money
    }
  }

  fragment SimpleReturns on SimpleReturns {
    amount {
      ...Money
    }
    asOf
    rate
    referenceDate
  }
`;
const fetchActivityFeedItemsQuery = /* GraphQL */ `
  query FetchActivityFeedItems(
    $first: Int
    $cursor: Cursor
    $condition: ActivityCondition
    $orderBy: [ActivitiesOrderBy!] = OCCURRED_AT_DESC
  ) {
    activityFeedItems(
      first: $first
      after: $cursor
      condition: $condition
      orderBy: $orderBy
    ) {
      edges {
        node {
          ...Activity
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }

  fragment Activity on ActivityFeedItem {
    accountId
    aftOriginatorName
    aftTransactionCategory
    aftTransactionType
    amount
    amountSign
    assetQuantity
    assetSymbol
    canonicalId
    currency
    eTransferEmail
    eTransferName
    externalCanonicalId
    identityId
    institutionName
    occurredAt
    p2pHandle
    p2pMessage
    spendMerchant
    securityId
    billPayCompanyName
    billPayPayeeNickname
    redactedExternalAccountNumber
    opposingAccountId
    status
    subType
    type
    strikePrice
    contractType
    expiryDate
    chequeNumber
    provisionalCreditAmount
    primaryBlocker
    interestRate
    frequency
    counterAssetSymbol
    rewardProgram
    counterPartyCurrency
    counterPartyCurrencyAmount
    counterPartyName
    fxRate
    fees
    reference
  }
`;
const fetchFundsTransferQuery = /* GraphQL */ `
  query FetchFundsTransfer($id: ID!) {
    fundsTransfer: funds_transfer(id: $id, include_cancelled: true) {
      ...FundsTransfer
    }
  }

  fragment FundsTransfer on FundsTransfer {
    id
    status
    cancellable
    rejectReason: reject_reason
    schedule {
      id
    }
    source {
      ...BankAccountOwner
    }
    destination {
      ...BankAccountOwner
    }
  }

  fragment BankAccountOwner on BankAccountOwner {
    bankAccount: bank_account {
      ...BankAccount
    }
  }

  fragment BankAccount on BankAccount {
    id
    accountName: account_name
    corporate
    createdAt: created_at
    currency
    institutionName: institution_name
    jurisdiction
    nickname
    type
    updatedAt: updated_at
    verificationDocuments: verification_documents {
      ...BankVerificationDocument
    }
    verifications {
      ...BankAccountVerification
    }
    ...CaBankAccount
    ...UsBankAccount
  }

  fragment CaBankAccount on CaBankAccount {
    accountName: account_name
    accountNumber: account_number
  }

  fragment UsBankAccount on UsBankAccount {
    accountName: account_name
    accountNumber: account_number
  }

  fragment BankVerificationDocument on VerificationDocument {
    id
    acceptable
    updatedAt: updated_at
    createdAt: created_at
    documentId: document_id
    documentType: document_type
    rejectReason: reject_reason
    reviewedAt: reviewed_at
    reviewedBy: reviewed_by
  }

  fragment BankAccountVerification on BankAccountVerification {
    custodianProcessedAt: custodian_processed_at
    custodianStatus: custodian_status
    document {
      ...BankVerificationDocument
    }
  }
`;
const fetchSpendTransactionsQuery = /* GraphQL */ `
  query FetchSpendTransactions(
    $transactionIds: [String!]
    $accountId: String!
    $cursor: String
  ) {
    spendTransactions(
      transactionIds: $transactionIds
      accountId: $accountId
      after: $cursor
    ) {
      edges {
        node {
          ...SpendTransaction
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }

  fragment SpendTransaction on SpendTransaction {
    id
    hasReward
    rewardAmount
    rewardPayoutType
    rewardPayoutSecurityId
    rewardPayoutCustodianAccountId
    foreignAmount
    foreignCurrency
    foreignExchangeRate
    isForeign
    roundupAmount
    roundupTotal
  }
`;
