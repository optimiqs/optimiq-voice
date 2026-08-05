function createAclsTestCases(expect) {
	const idBase = "acls";

	return {
		api: "Acls",
		cases: [
			{
				id: `${idBase}-00`,
				name: "should create an acl",
				method: "createAcl",
				request: {
					name: "From Optimiq Voice",
					allow: ["192.168.1.10"],
				},
				responseValidator: (response: { ref: string }) => {
					expect(response).has.property("ref");
				},
			},
			{
				id: `${idBase}-01`,
				name: "should get the acl",
				method: "getAcl",
				request: "{{ref}}",
				dependsOn: `${idBase}-00`,
				responseValidator: (response: { ref: string }) => {
					expect(response).has.property("ref");
					expect(response).has.property("name");
					expect(response).has.property("allow").to.be.an("array").to.have.lengthOf(1);
					expect(response).has.property("createdAt").to.be.a("date");
					expect(response).has.property("updatedAt").to.be.a("date");
				},
			},
			{
				id: `${idBase}-02`,
				name: "should update the acl",
				method: "updateAcl",
				request: {
					ref: "{{ref}}",
					name: "From Optimiq Voice Updated",
					allow: ["192.168.1.11"],
				},
				dependsOn: `${idBase}-00`,
				responseValidator: (response: { ref: string }) => {
					expect(response).has.property("ref");
				},
			},
			{
				id: `${idBase}-03`,
				name: "should list at least one acl",
				method: "listAcls",
				request: {
					pageSize: 10,
					pageToken: null,
				},
				responseValidator: (response: { items: unknown[]; nextPageToken: string }) => {
					expect(response).has.property("items");
					expect(response).has.property("nextPageToken");
					expect(response.items.length).to.be.greaterThan(0);
					expect(response.items[0]).to.have.property("ref").to.not.be.null;
					expect(response.items[0]).to.have.property("name").to.not.be.null;
					expect(response.items[0]).to.have.property("allow").to.be.an("array").to.have.lengthOf(1);
					expect(response.items[0]).to.have.property("createdAt").to.be.a("date");
					expect(response.items[0]).to.have.property("updatedAt").to.be.a("date");
				},
			},
			{
				id: `${idBase}-04`,
				name: "should delete the acl",
				method: "deleteAcl",
				request: "{{ref}}",
				dependsOn: `${idBase}-00`,
				responseValidator: (response: { ref: string }) => {
					expect(response).has.property("ref");
				},
			},
			{
				id: `${idBase}-05`,
				name: "should fail to delete the acl (not found)",
				method: "deleteAcl",
				request: "{{ref}}",
				dependsOn: `${idBase}-00`,
				grpcCode: 5,
			},
		],
	};
}

export { createAclsTestCases };
