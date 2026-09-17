import { Solid } from 'remotion';
import React from 'react';

export const NewComposition: React.FC = () => {
	return (
		<>
			<Solid
				width={1920}
				height={1080}
				color="gray"
				style={{ position: "absolute" }}
			/>
		</>
	);
};
