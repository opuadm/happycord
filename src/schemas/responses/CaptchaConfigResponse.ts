export interface CaptchaConfigResponse {
    service: "cap" | null;
    sitekey: string | null;
    endpoint: string | null;
    register: boolean;
    login: boolean;
    password_reset: boolean;
    endpoints?: {
        register: string | null;
        login: string | null;
        password_reset: string | null;
    };
}
