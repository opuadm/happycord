/* SPDX-License-Identifier: AGPL-3.0-only */
import { BaseEntity, Column, Entity, Index, PrimaryColumn } from "typeorm";

@Entity({ name: "discovery_terms" })
@Index("IDX_discovery_terms_guild_id", ["guild_id"])
export class DiscoveryTerm extends BaseEntity {
    @PrimaryColumn({ type: "varchar", length: 100 }) term: string;
    @PrimaryColumn({ type: "int8" }) guild_id: string;
    @Column({ type: "int2" }) weight: number;
}
