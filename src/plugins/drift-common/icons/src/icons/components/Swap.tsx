import * as React from 'react';
import { IconProps } from '../../types';
import { IconWrapper } from '../IconWrapper';

const Swap = (allProps: IconProps) => {
	const { svgProps: props, ...restProps } = allProps;
	return (
		<IconWrapper
			icon={
				<svg
					viewBox="0 0 24 24"
					fill="none"
					xmlns="http://www.w3.org/2000/svg"
					{...props}
				>
					<path
						fillRule="evenodd"
						clipRule="evenodd"
						d="M3.307 15.213A.75.75 0 014 14.75h16a.75.75 0 010 1.5H5.81l2.72 2.72a.75.75 0 11-1.06 1.06l-4-4a.75.75 0 01-.163-.817zM3.25 8.5A.75.75 0 014 7.75h14.19l-2.72-2.72a.75.75 0 011.06-1.06l4 4A.75.75 0 0120 9.25H4a.75.75 0 01-.75-.75z"
						fill={allProps.color ? allProps.color : 'currentColor'}
					/>
				</svg>
			}
			{...restProps}
		/>
	);
};
export default Swap;
