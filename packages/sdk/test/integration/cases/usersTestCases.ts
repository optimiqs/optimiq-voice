function createUsersTestCases(expect) {
	const idBase = "users";

	return {
		api: "Users",
		cases: [
			{
				id: `${idBase}-00`,
				name: "should create a user",
				method: "createUser",
				request: {
					name: "John Doe",
					email: `john${Math.floor(Math.random() * 100000)}@example.com`,
					password: "password",
					avatar: "https://example.com/avatar.jpg",
				},
				responseValidator: (response: { ref: string }) => {
					expect(response).has.property("ref");
				},
			},
			{
				id: `${idBase}-01`,
				name: "should get the user",
				method: "getUser",
				request: "00000000-0000-0000-0000-000000000000",
				responseValidator: (response: { ref: string }) => {
					expect(response).has.property("ref").to.not.be.null;
					expect(response).has.property("name").to.not.be.null;
					expect(response).has.property("email").to.not.be.null;
					expect(response).has.property("createdAt").to.be.a("date");
					expect(response).has.property("updatedAt").to.be.a("date");
				},
			},
			{
				id: `${idBase}-02`,
				name: "should update the user",
				method: "updateUser",
				request: {
					ref: "00000000-0000-0000-0000-000000000000",
					name: "Jane Doe",
					password: "changeme",
					avatar: "https://example.com/a-different-avatar.jpg",
				},
				responseValidator: (response: { ref: string }) => {
					expect(response).has.property("ref");
				},
			},
		],
	};
}

export { createUsersTestCases };
