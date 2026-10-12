import {
    ApiConfiguration,
    AutomodConfiguration,
    CdnConfiguration,
    ClientConfiguration,
    ComponentConfiguration,
    DefaultsConfiguration,
    EmailConfiguration,
    EmbedConfiguration,
    EndpointConfiguration,
    ExternalTokensConfiguration,
    ExternalRequestConfiguration,
    GeneralConfiguration,
    GifConfiguration,
    GuildConfiguration,
    IntegrationConfiguration,
    LimitsConfiguration,
    LoginConfiguration,
    OffloadConfiguration,
    PasswordResetConfiguration,
    RabbitMQConfiguration,
    RegionConfiguration,
    RegisterConfiguration,
    SecurityConfiguration,
    TemplateConfiguration,
    UserConfiguration,
} from "./types";

export class ConfigValue {
    admin: EndpointConfiguration = new EndpointConfiguration();
    gateway: EndpointConfiguration = new EndpointConfiguration();
    cdn: CdnConfiguration = new CdnConfiguration();
    client: ClientConfiguration = new ClientConfiguration();
    api: ApiConfiguration = new ApiConfiguration();
    general: GeneralConfiguration = new GeneralConfiguration();
    limits: LimitsConfiguration = new LimitsConfiguration();
    security: SecurityConfiguration = new SecurityConfiguration();
    login: LoginConfiguration = new LoginConfiguration();
    register: RegisterConfiguration = new RegisterConfiguration();
    regions: RegionConfiguration = new RegionConfiguration();
    guild: GuildConfiguration = new GuildConfiguration();
    gif: GifConfiguration = new GifConfiguration();
    rabbitmq: RabbitMQConfiguration = new RabbitMQConfiguration();
    templates: TemplateConfiguration = new TemplateConfiguration();
    defaults: DefaultsConfiguration = new DefaultsConfiguration();
    externalRequests: ExternalRequestConfiguration = new ExternalRequestConfiguration();
    external: ExternalTokensConfiguration = new ExternalTokensConfiguration();
    email: EmailConfiguration = new EmailConfiguration();
    passwordReset: PasswordResetConfiguration = new PasswordResetConfiguration();
    user: UserConfiguration = new UserConfiguration();
    offload: OffloadConfiguration = new OffloadConfiguration();
    components = new ComponentConfiguration();
    embeds = new EmbedConfiguration();
    integrations = new IntegrationConfiguration();
    automod: AutomodConfiguration = new AutomodConfiguration();
    defaultsRevision: number = 0;
}
