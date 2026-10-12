import {
    DateOfBirthConfiguration,
    InstanceInviteConfiguration,
    PasswordConfiguration,
    RegistrationEmailConfiguration,
    RegistrationJoinReasonConfiguration,
} from "./subconfigurations";

export class RegisterConfiguration {
    email: RegistrationEmailConfiguration = new RegistrationEmailConfiguration();
    dateOfBirth: DateOfBirthConfiguration = new DateOfBirthConfiguration();
    password: PasswordConfiguration = new PasswordConfiguration();
    joinReason: RegistrationJoinReasonConfiguration = new RegistrationJoinReasonConfiguration();
    requireApproval: boolean = false;
    disabled: boolean = false;
    requireCaptcha: boolean = true;
    requireInvite: boolean = false;
    instanceInvites: InstanceInviteConfiguration = new InstanceInviteConfiguration();
    guestsRequireInvite: boolean = true;
    allowNewRegistration: boolean = true;
    allowMultipleAccounts: boolean = true;
    blockIpDataCoThreatTypes: string[] = ["tor", "icloud_relay", "proxy", "datacenter", "anonymous", "known_attacker", "known_abuser", "threat"]; // matching ipdata's threat.is_* fields as of 2025/11/30, minus bogon
    blockAsnTypes: string[] = [""];
    blockAsns: string[] = [""];
    blockAbuseIpDbAboveScore: number = 75; // 0 to disable
    incrementingDiscriminators: boolean = false; // random otherwise
    defaultRights: string = "875069521787904"; // See `bun run generate:rights`
    enableAbuseIpDb: boolean = false;
    enableIpData: boolean = false;
    blacklistedUsernames: string[] = []; // nobody can register or rename to these; `*` matches any run of characters
}
