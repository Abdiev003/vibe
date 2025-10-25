import React from 'react'

interface PageProps {
  params: Promise<{
    projectId: string;
  }>
}

const Page = async ({ params }: PageProps) => {
  const { projectId } = await params;

  return (
    <div>
        Project Id: {projectId}
    </div>
  )
}

export default Page