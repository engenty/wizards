/*
 * The broker: the one path every connector call takes (docs/plans/broker.md). Tools, share
 * targets, plugins and the run's browser import from here; `account.ts` stays the broker's own.
 */
export { type Account, grantedScopes } from "./account.js";
export {
  type ActionKind,
  type BrokerAction,
  type BrokerCallInput,
  type BrokerConnection,
  type BrokerContext,
  type BrokerResult,
  brokerCall,
  brokerConnected,
  brokerPullStream,
  brokerReadMessage,
  brokerSecret,
  CONNECTION_PAUSED,
  type Decision,
  decide,
  grantBinds,
  inAudience,
  kindOf,
  type Refusal,
  type SecretResult,
  signInRefused,
  type Where,
  type Who,
  type WhoKind,
  whereOf,
  whereOfRun,
  whoOf,
} from "./call.js";
export { type Caller, currentCaller, withCaller } from "./caller.js";
export {
  channelInGrant,
  type FixedChannel,
  type Grant,
  grantNote,
  grantOf,
  hostInGrant,
  inGrant,
  type KnownConnector,
  runGrant,
} from "./grant.js";
export { brokerHost, type HostResult, runHosts } from "./host.js";
export { keptStepIds } from "./kept.js";
export {
  CALLS_PER_DAY,
  CALLS_PER_RUN,
  type CallLimits,
  CRITICAL_KINDS,
  type CriticalKind,
  callsToday,
  criticalOf,
  criticalSince,
  cursorOf,
  LOG_PAGE,
  type LogCursor,
  type LoggedRow,
  type LogQuery,
  lastUseOf,
  logLine,
  logOfSpace,
  logRuleChange,
  onCritical,
  RULE_CHANGE_ACTION,
  readCursor,
  SIGN_IN_FAILED,
  summarizeInput,
} from "./log.js";
export {
  mailWire,
  type NamedCall,
  type ResponseWire,
  requestWire,
  responseOf,
} from "./named.js";
export { type RunOver, runOver } from "./over.js";
export {
  descriptorOf,
  type OutsideReach,
  outsideReaches,
  reachesOutside,
  type ToolDescriptor,
  toolDescriptors,
} from "./registry.js";
export {
  brokerSend,
  channelOf,
  FIXED_CHANNEL_ONLY,
  GUEST_MAILS_PER_RUN,
  type GuestSend,
  guestPostCheck,
  guestSendCheck,
  postsToChannel,
  recipientsOf,
  runAddresses,
  type SendCheck,
  type SendRefusal,
  type SendResult,
} from "./send.js";
