import { caller } from "@/trpc/server";
import React from "react";

const Page = async () => {
  const data = await caller.hello({ text: "world" });

  return <div>{data?.greeting}</div>;
};

export default Page;
