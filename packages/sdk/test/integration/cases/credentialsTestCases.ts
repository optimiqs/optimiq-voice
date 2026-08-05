function createCredentialsTestCases(expect) {
	const idBase = "credentials";

	return {
		api: "Credentials",
		cases: [
			{
				id: `${idBase}-00`,
				name: "should create a set of credentials",
				method: "createCredentials",
				request: {
					name: "My Credentials",
					username: "myusername",
					password: "mysecret",
				},
				responseValidator: (response: { ref: string }) => {
					expect(response).has.property("ref");
				},
			},
			{
				id: `${idBase}-01`,
				name: "should get the credential",
				method: "getCredentials",
				request: "{{ref}}",
				dependsOn: `${idBase}-00`,
				responseValidator: (response: { ref: string }) => {
					expect(response).has.property("ref").to.not.be.null;
					expect(response).has.property("name").to.not.be.null;
					expect(response).has.property("username").to.not.be.null;
					expect(response).to.not.have.property("password");
					expect(response).has.property("createdAt").to.be.a("date");
					expect(response).has.property("updatedAt").to.be.a("date");
				},
			},
			{
				id: `${idBase}-02`,
				name: "should update the name of the credential",
				method: "updateCredentials",
				request: {
					ref: "{{ref}}",
					name: "My New Credentials",
					password: "changed",
				},
				dependsOn: `${idBase}-00`,
				responseValidator: (response: { ref: string }) => {
					expect(response).has.property("ref");
				},
			},
			{
				id: `${idBase}-03`,
				name: "should list at least one set of credentials",
				method: "listCredentials",
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
					expect(response.items[0]).to.have.property("username").to.not.be.null;
					expect(response.items[0]).to.not.have.property("password");
					expect(response.items[0]).to.have.property("createdAt").to.be.a("date");
					expect(response.items[0]).to.have.property("updatedAt").to.be.a("date");
				},
			},
			{
				id: `${idBase}-04`,
				name: "should delete the credential",
				method: "deleteCredentials",
				request: "{{ref}}",
				dependsOn: `${idBase}-00`,
				responseValidator: (response: { ref: string }) => {
					expect(response).has.property("ref");
				},
			},
			{
				id: `${idBase}-05`,
				name: "should fail to delete the credentials (not found)",
				method: "deleteCredentials",
				request: "{{ref}}",
				dependsOn: `${idBase}-00`,
				grpcCode: 5,
			},
		],
	};
}

export { createCredentialsTestCases };
