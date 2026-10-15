/* SPDX-License-Identifier: AGPL-3.0-only */
const { StubError, loadModule } = require("./route-harness.cjs");

function loadStaffModules({ roles = [], members = [] } = {}) {
    const staffRoles = {};
    const bitField = loadModule("src/util/util/BitField.ts", {});
    const rights = loadModule("src/util/util/Rights.ts", {
        "./BitField": bitField,
        "../../database/entities": { User: {} },
        "lambert-server/HTTPError": { HTTPError: StubError },
        "./StaffRoles": staffRoles,
    });
    const database = {
        StaffRole: { find: async () => roles },
        StaffRoleMember: { find: async () => members },
    };
    Object.assign(
        staffRoles,
        loadModule("src/util/util/StaffRoles.ts", {
            "../../database/entities/StaffRole": database,
            "./Rights": rights,
        }),
    );
    const util = { ...bitField, ...rights, ...staffRoles };
    return { util, database, Rights: rights.Rights, FLAGS: rights.Rights.FLAGS };
}

module.exports = { loadStaffModules };
