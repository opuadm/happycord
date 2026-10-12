export class CapChallengeConfiguration {
    count: number;
    size: number;
    difficulty: number;

    constructor(count: number, size: number, difficulty: number) {
        this.count = count;
        this.size = size;
        this.difficulty = difficulty;
    }
}

export class CapChallengesConfiguration {
    register: CapChallengeConfiguration = new CapChallengeConfiguration(64, 32, 5);
    login: CapChallengeConfiguration = new CapChallengeConfiguration(16, 32, 5);
    passwordReset: CapChallengeConfiguration = new CapChallengeConfiguration(16, 32, 5);
}

export class CaptchaConfiguration {
    capMode: "core" | "standalone" = "core";
    enabled: boolean = false;
    sitekey: string | null = null;
    secret: string | null = null;
    instance: string | null = null;
    blockAutomatedBrowsers: boolean = true;
    challenges: CapChallengesConfiguration = new CapChallengesConfiguration();
}
